import { spawn } from "node:child_process";
import { type ClientConnection, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import type { AcpAgentDefinition } from "../../runtime/config.ts";
import { executableLaunch, platformSpawnOptions, stopProcessTree } from "../../util/process/executable.ts";
import { isRecord, truncate } from "../../util/value-utils.ts";
import { AcpExecutionError } from "../acp-error.ts";
import {
    type AcpEndpointTermination,
    acpEndpointTerminationError,
    type InProcessAcpEndpoint,
} from "../agent/in-process-endpoint.ts";
import { type AcpClientHandler, createAcpClient } from "./create-client.ts";

function requestErrorMessage(error: RequestError): string {
    const fallback = truncate(error.message, 500);
    if (error.message !== "Internal error" || !isRecord(error.data)) {
        return fallback;
    }
    const agentError = error.data["error"];
    if (isRecord(agentError)) {
        const message = agentError["message"];
        if (typeof message === "string" && message.length > 0) {
            return truncate(message, 500);
        }
    }
    const details = error.data["details"];
    return typeof details === "string" && details.length > 0 ? truncate(details, 500) : fallback;
}

function readableWebStream(input: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
    let streamOpen = true;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            input.on("data", (chunk: unknown) => {
                if (!streamOpen) {
                    return;
                }
                if (chunk instanceof Uint8Array) {
                    controller.enqueue(new Uint8Array(chunk));
                    return;
                }
                streamOpen = false;
                controller.error(new Error("ACP process produced a non-binary chunk"));
            });
            input.once("end", () => {
                if (!streamOpen) {
                    return;
                }
                streamOpen = false;
                controller.close();
            });
            input.once("error", (error) => {
                if (!streamOpen) {
                    return;
                }
                streamOpen = false;
                controller.error(error);
            });
        },
        cancel() {
            streamOpen = false;
        },
    });
}

export function createWritableAcpStream(output: NodeJS.WritableStream): WritableStream<Uint8Array> {
    let outputFailure: unknown;
    const pendingWriteFailures = new Set<(error: unknown) => void>();
    const fail = (error: unknown): void => {
        outputFailure = error;
        for (const reject of pendingWriteFailures) {
            reject(error);
        }
        pendingWriteFailures.clear();
    };
    output.on("error", fail);
    output.once("close", () => {
        if (outputFailure === undefined) {
            fail(new Error("ACP process input closed"));
        }
    });
    return new WritableStream<Uint8Array>({
        write(chunk) {
            if (outputFailure !== undefined) {
                return Promise.reject(outputFailure);
            }
            return new Promise<void>((resolve, reject) => {
                pendingWriteFailures.add(reject);
                output.write(chunk, (error) => {
                    pendingWriteFailures.delete(reject);
                    if (error) {
                        outputFailure = error;
                        reject(error);
                        return;
                    }
                    if (outputFailure !== undefined) {
                        reject(outputFailure);
                        return;
                    }
                    resolve();
                });
            });
        },
    });
}

type EndpointProcess =
    | { readonly kind: "in-process"; readonly endpoint: InProcessAcpEndpoint }
    | { readonly kind: "child"; readonly child: ReturnType<typeof spawn> };

/** Owns the transport, termination signal and process tree for one Agent endpoint. */
export class AgentConnection {
    readonly connection: ClientConnection;
    readonly termination: Promise<AcpEndpointTermination>;
    readonly #process: EndpointProcess;
    constructor(agent: AcpAgentDefinition, cwd: string, client: AcpClientHandler) {
        if (agent.kind === "in-process-acp") {
            // Mobius hosts the ACP Agent in-process and drives the vendor's own protocol, so there is
            // no adapter process to spawn or supervise here. The endpoint owns its own resources.
            const inProcess = agent.createEndpoint({
                command: agent.command,
                cwd,
                environment: agent.environment,
            });
            this.#process = { kind: "in-process", endpoint: inProcess };
            this.termination = inProcess.terminated;
            this.connection = createAcpClient(client).connect(inProcess.app());
            return;
        }
        const launch = executableLaunch(agent.adapterPath, agent.arguments);
        const child = spawn(launch.command, [...launch.arguments], {
            cwd,
            ...platformSpawnOptions,
            env: { ...process.env, ...agent.environment },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.#process = { kind: "child", child };
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (stdin === null || stdout === null || stderr === null) {
            child.kill("SIGKILL");
            throw new AcpExecutionError("ACP process streams are unavailable");
        }
        stderr.setEncoding("utf8");
        stderr.on("data", (chunk: string) => {
            process.stderr.write(`[${agent.id}-acp] ${chunk}`);
        });
        this.termination = new Promise<AcpEndpointTermination>((resolve) => {
            child.once("error", (cause) => {
                resolve({ kind: "failed", error: new AcpExecutionError("The ACP process could not run", { cause }) });
            });
            child.once("exit", (code, signal) => {
                resolve({
                    kind: "failed",
                    error: new AcpExecutionError("The ACP process stopped", { cause: { code, signal } }),
                });
            });
        });
        const stream = ndJsonStream(createWritableAcpStream(stdin), readableWebStream(stdout));
        this.connection = createAcpClient(client).connect(stream);
    }
    get inProcessAgent(): InProcessAcpEndpoint | null {
        return this.#process.kind === "in-process" ? this.#process.endpoint : null;
    }
    readonly closeProcess = async (): Promise<void> => {
        try {
            if (this.#process.kind === "in-process") {
                // The in-process agent owns its app-server child and its process tree.
                await this.#process.endpoint.close();
                return;
            }
            await stopProcessTree(this.#process.child);
        } finally {
            this.connection.close();
        }
    };

    readonly race = async <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> => {
        let removeAbortListener = (): void => {};
        const aborted = new Promise<never>((_resolve, reject) => {
            const rejectAbort = (): void => {
                reject(signal.reason ?? new Error("ACP request was cancelled"));
            };
            signal.addEventListener("abort", rejectAbort, { once: true });
            removeAbortListener = (): void => {
                signal.removeEventListener("abort", rejectAbort);
            };
            if (signal.aborted) {
                rejectAbort();
            }
        });
        try {
            try {
                return await Promise.race([
                    // The caller has already started operation. Even when cancellation
                    // won before entry, observe its later rejection during endpoint cleanup.
                    aborted,
                    operation,
                    this.termination.then((termination) => {
                        const cause = acpEndpointTerminationError(termination);
                        throw new AcpExecutionError(exitMessage, { cause }, cause.code);
                    }),
                ]);
            } catch (error) {
                signal.throwIfAborted();
                if (error instanceof RequestError && error.code === -32_000) {
                    throw new AcpExecutionError(
                        "Agent authentication is required",
                        { cause: error },
                        "authentication_required",
                    );
                }
                if (error instanceof RequestError) {
                    throw new AcpExecutionError(requestErrorMessage(error), { cause: error }, "acp_agent_error");
                }
                throw error;
            }
        } finally {
            removeAbortListener();
        }
    };
}
