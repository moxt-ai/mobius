import {
    type ClientConnection,
    type CompleteElicitationNotification,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    type InitializeResponse,
    methods,
    PROTOCOL_VERSION,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { SessionCapabilities } from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { AcpAgentDefinition } from "../../acp/agent/agent-definition.ts";
import type { AcpClientHandler } from "../../acp/connection/create-client.ts";
import { normalizeAcpCapabilities } from "../../acp/protocol/session-capabilities.ts";
import { AgentProbeError } from "./agent-probe-error.ts";
import { normalizeVersionOutput } from "./version-output.ts";

export class VerifiedAcpReadiness {
    readonly adapterVersion: string;
    readonly capabilities: SessionCapabilities;

    constructor(adapterVersion: string, capabilities: SessionCapabilities) {
        this.adapterVersion = adapterVersion;
        this.capabilities = capabilities;
    }
}

export interface AgentReadinessProbeParams {
    readonly agent: AcpAgentDefinition;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly defaultWorkspace: string;
    readonly signal: AbortSignal;
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

export function filterEnvironment(environment: Readonly<NodeJS.ProcessEnv>): Readonly<Record<string, string>> {
    const filtered: Record<string, string> = {};
    for (const [name, value] of Object.entries(environment)) {
        if (typeof value === "string") {
            filtered[name] = value;
        }
    }
    return filtered;
}

/** Exercises the same adapter-owned connection used by sessions, with a bounded probe lifetime. */
export async function probeAcpReadiness(
    specification: {
        readonly acpProbeTimeoutMilliseconds: number;
        readonly authenticationCommand: () => string;
        readonly verifyAcp: (
            connection: ClientConnection,
            initialized: InitializeResponse,
            defaultWorkspace: string,
            signal: AbortSignal,
        ) => Promise<void>;
    },
    agent: AcpAgentDefinition,
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
    try {
        const runtime = agent
            .withEnvironment({ ...filterEnvironment(environment), ...agent.environment })
            .createConnection({
                cwd: defaultWorkspace,
                client: new DiscoveryAcpHandler(),
            });
        try {
            return await runtime.race(
                (async () => {
                    await runtime.initialize(controller.signal);
                    const initialized = await runtime.connection.agent.request(
                        methods.agent.initialize,
                        {
                            clientCapabilities: {},
                            clientInfo: { name: "mobius", version: "0.0.3" },
                            protocolVersion: PROTOCOL_VERSION,
                        },
                        { cancellationSignal: controller.signal },
                    );
                    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
                        throw new AgentProbeError(
                            "acp_incompatible",
                            "ACP agent selected an unsupported protocol version",
                        );
                    }
                    await specification.verifyAcp(runtime.connection, initialized, defaultWorkspace, controller.signal);
                    return new VerifiedAcpReadiness(
                        normalizeVersionOutput(initialized.agentInfo?.version ?? ""),
                        normalizeAcpCapabilities(initialized),
                    );
                })(),
                "The ACP endpoint stopped during initialization",
                controller.signal,
            );
        } finally {
            await runtime.closeProcess();
        }
    } catch (error) {
        signal.throwIfAborted();
        if (timedOut) {
            throw new AgentProbeError("adapter_probe_timeout", "ACP agent probe timed out", { cause: error });
        }
        if (error instanceof AgentProbeError) {
            throw error;
        }
        if (
            error instanceof AcpExecutionError &&
            error.code === "authentication_required" &&
            specification.authenticationCommand().length > 0
        ) {
            throw new AgentProbeError("authentication_required", "Agent authentication is required", { cause: error });
        }
        throw new AgentProbeError("acp_incompatible", "ACP agent initialization failed", { cause: error });
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
    }
}
