import { spawn } from "node:child_process";

import {
    type ClientConnection,
    type CompleteElicitationNotification,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    methods,
    ndJsonStream,
    PROTOCOL_VERSION,
    RequestError,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { SessionCapabilities } from "@moxt-ai/mobius-protocol";

import { type AcpClientHandler, createAcpClient } from "../acp/create-client.ts";
import { normalizeAcpCapabilities } from "../acp/session-capabilities.ts";
import { stopProcessTree } from "../process/executable.ts";
import { AgentProbeError } from "./agent-probe-error.ts";
import type { LocalAgentSpecification } from "./agent-specification.ts";
import { normalizedVersion } from "./executable-discovery.ts";
import type { LocalAgentDefinition } from "./local-agent.ts";

const ACP_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export class VerifiedAcpReadiness {
    readonly adapterVersion: string;
    readonly capabilities: SessionCapabilities;

    constructor(adapterVersion: string, capabilities: SessionCapabilities) {
        this.adapterVersion = adapterVersion;
        this.capabilities = capabilities;
    }
}

class DiscoveryAcpHandler implements AcpClientHandler {
    readonly onElicitation = (
        _request: CreateElicitationRequest,
        _signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => Promise.reject(new Error("ACP probe does not accept elicitations"));

    readonly onElicitationComplete = (_notification: CompleteElicitationNotification): Promise<void> =>
        Promise.resolve();

    readonly onPermission = (
        _request: RequestPermissionRequest,
        _signal: AbortSignal,
    ): Promise<RequestPermissionResponse> => Promise.reject(new Error("ACP probe does not grant permissions"));

    readonly onUpdate = (_notification: SessionNotification): Promise<void> => Promise.resolve();
}

function readableAcpStream(input: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
    let byteLength = 0;
    let open = true;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            input.on("data", (chunk: unknown) => {
                if (!open) {
                    return;
                }
                if (!(chunk instanceof Uint8Array)) {
                    open = false;
                    controller.error(new Error("ACP adapter produced invalid output"));
                    return;
                }
                byteLength += chunk.byteLength;
                if (byteLength > ACP_OUTPUT_LIMIT_BYTES) {
                    open = false;
                    controller.error(new Error("ACP adapter output limit exceeded"));
                    return;
                }
                controller.enqueue(new Uint8Array(chunk));
            });
            input.once("end", () => {
                if (open) {
                    open = false;
                    controller.close();
                }
            });
            input.once("error", (error) => {
                if (open) {
                    open = false;
                    controller.error(error);
                }
            });
        },
        cancel() {
            open = false;
        },
    });
}

function writableAcpStream(output: NodeJS.WritableStream): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
        write(chunk) {
            return new Promise<void>((resolveWrite, rejectWrite) => {
                output.write(chunk, (error) => {
                    if (error) {
                        rejectWrite(error);
                        return;
                    }
                    resolveWrite();
                });
            });
        },
    });
}

export async function probeAcpReadiness(
    specification: LocalAgentSpecification,
    agent: LocalAgentDefinition,
    environment: Readonly<NodeJS.ProcessEnv>,
    defaultWorkspace: string,
    signal: AbortSignal,
): Promise<VerifiedAcpReadiness> {
    signal.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("ACP probe timed out"));
    }, specification.acpProbeTimeoutMilliseconds);
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
        abort();
    }
    const child = spawn(agent.adapterPath, [...agent.arguments], {
        cwd: defaultWorkspace,
        detached: process.platform !== "win32",
        env: { ...environment, ...agent.environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const processExit = new Promise<never>((_resolve, reject) => {
        const rejectExit = (): void => reject(new Error("ACP adapter exited during initialization"));
        child.once("error", reject);
        child.once("exit", rejectExit);
        if (child.exitCode !== null || child.signalCode !== null) {
            rejectExit();
        }
    });
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdin === null || stdout === null || stderr === null) {
        await stopProcessTree(child);
        throw new AgentProbeError("acp_incompatible", "ACP adapter streams are unavailable");
    }
    let stderrBytes = 0;
    const consumeStderr = (chunk: Buffer): void => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > ACP_OUTPUT_LIMIT_BYTES) {
            controller.abort(new Error("ACP adapter output limit exceeded"));
        }
    };
    stderr.on("data", consumeStderr);
    const connection: ClientConnection = createAcpClient(new DiscoveryAcpHandler()).connect(
        ndJsonStream(writableAcpStream(stdin), readableAcpStream(stdout)),
    );

    try {
        const initialized = await Promise.race([
            connection.agent.request(
                methods.agent.initialize,
                {
                    clientCapabilities: {},
                    clientInfo: { name: "mobius", version: "0.0.3" },
                    protocolVersion: PROTOCOL_VERSION,
                },
                { cancellationSignal: controller.signal },
            ),
            processExit,
        ]);
        if (initialized.protocolVersion !== PROTOCOL_VERSION) {
            throw new AgentProbeError("acp_incompatible", "ACP adapter selected an unsupported protocol version");
        }
        await specification.verifyAcp(connection, initialized, defaultWorkspace, controller.signal);
        return new VerifiedAcpReadiness(
            normalizedVersion(initialized.agentInfo?.version ?? ""),
            normalizeAcpCapabilities(initialized),
        );
    } catch (error) {
        if (signal.aborted) {
            signal.throwIfAborted();
        }
        if (timedOut) {
            throw new AgentProbeError("adapter_probe_timeout", "ACP adapter probe timed out", { cause: error });
        }
        if (error instanceof AgentProbeError) {
            throw error;
        }
        if (
            error instanceof RequestError &&
            error.code === -32_000 &&
            specification.authenticationCommand().length > 0
        ) {
            throw new AgentProbeError("authentication_required", "Agent authentication is required", { cause: error });
        }
        throw new AgentProbeError("acp_incompatible", "ACP adapter initialization failed", { cause: error });
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        connection.close();
        stdin.end();
        stderr.removeListener("data", consumeStderr);
        await stopProcessTree(child);
    }
}
