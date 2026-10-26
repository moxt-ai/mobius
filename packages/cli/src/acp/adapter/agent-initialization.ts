import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { revalidateExecutable } from "../../util/process/executable.ts";
import { truncate } from "../../util/value-utils.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import { normalizeAcpCapabilities } from "../protocol/session-capabilities.ts";
import type { AdapterSessionConnection } from "./session-events.ts";

export class RetryableAcpInitializationError extends AcpExecutionError {
    constructor(cause: unknown) {
        super("ACP agent initialization failed", { cause });
        this.name = "RetryableAcpInitializationError";
    }
}

export async function validateAgentRuntime(agent: AcpAgentDefinition, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const unchanged = await Promise.all([
        agent.kind === "acp-adapter-process" ? revalidateExecutable(agent.adapterIdentity) : Promise.resolve(true),
        revalidateExecutable(agent.agentIdentity),
    ]);
    signal.throwIfAborted();
    if (unchanged.some((result) => !result)) {
        throw new AcpExecutionError(
            "The local Agent runtime changed; restart Mobius before starting a new conversation",
            {},
            "agent_runtime_changed",
        );
    }
}

export async function initializeAgentConnection(
    connection: AdapterSessionConnection,
    agentId: string,
    verifiedVersion: string,
    signal: AbortSignal,
) {
    if (connection.inProcessAgent !== null) {
        await connection
            .race(
                connection.inProcessAgent.initialize(signal),
                "The Codex app-server exited during initialization",
                signal,
            )
            .catch((cause: unknown) => {
                signal.throwIfAborted();
                throw new RetryableAcpInitializationError(cause);
            });
    }
    const initialized = await connection
        .race(
            connection.connection.agent.request(
                methods.agent.initialize,
                {
                    clientCapabilities: {
                        elicitation: { form: {}, url: {} },
                        plan: {},
                        session: { compaction: {}, configOptions: { boolean: {} } },
                    },
                    clientInfo: { name: "mobius", version: "0.0.3" },
                    protocolVersion: PROTOCOL_VERSION,
                },
                { cancellationSignal: signal },
            ),
            "ACP agent exited during initialization",
            signal,
        )
        .catch((cause: unknown) => {
            signal.throwIfAborted();
            throw new RetryableAcpInitializationError(cause);
        });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new AcpExecutionError(
            "ACP agent selected an unsupported protocol version",
            {},
            "unsupported_acp_protocol",
        );
    }
    return {
        capabilities: normalizeAcpCapabilities(initialized),
        agentName: truncate(initialized.agentInfo?.title ?? initialized.agentInfo?.name ?? agentId, 255),
        agentVersion: truncate(
            verifiedVersion.length > 0 ? verifiedVersion : (initialized.agentInfo?.version ?? ""),
            128,
        ),
    };
}
