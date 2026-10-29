import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { revalidateExecutable } from "../../util/process/executable.ts";
import { truncate } from "../../util/value-utils.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import type { AgentConnection } from "../connection/agent-connection.ts";
import { normalizeAcpCapabilities } from "../protocol/session-capabilities.ts";

export class RetryableAcpInitializationError extends AcpExecutionError {
    constructor(cause: unknown) {
        super("ACP agent initialization failed", { cause });
        this.name = "RetryableAcpInitializationError";
    }
}

export async function validateAgentRuntime(agent: AcpAgentDefinition, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const unchanged = await Promise.all(agent.runtimeExecutables.map((identity) => revalidateExecutable(identity)));
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
    connection: Pick<AgentConnection, "connection" | "initialize" | "race">,
    agentId: string,
    verifiedVersion: string,
    signal: AbortSignal,
) {
    await connection
        .race(connection.initialize(signal), "The Agent runtime exited during initialization", signal)
        .catch((cause: unknown) => {
            signal.throwIfAborted();
            throw new RetryableAcpInitializationError(cause);
        });
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
