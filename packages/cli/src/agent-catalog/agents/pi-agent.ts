import {
    type AgentCapabilities,
    type ClientConnection,
    type InitializeResponse,
    methods,
} from "@agentclientprotocol/sdk";

import { PiAcpEndpoint } from "../../acp/harness/pi/endpoint.ts";
import type { InProcessAcpEndpointFactory } from "../../acp/in-process/acp-endpoint.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { InProcessAcpAgentDefinition } from "../agent-specification.ts";

const ACP_PROBE_TIMEOUT_MILLISECONDS = 30_000;

export class PiAgentSpecification extends InProcessAcpAgentDefinition {
    override readonly acpProbeTimeoutMilliseconds = ACP_PROBE_TIMEOUT_MILLISECONDS;
    readonly agentExecutable = "pi";
    readonly createEndpoint: InProcessAcpEndpointFactory = (options) => new PiAcpEndpoint(options);
    readonly id = "pi";
    readonly label = "Pi";
    override readonly minimumSupportedAgentVersion = "0.85.0";
    override readonly maximumTestedAgentVersion = "1.1.0";
    override readonly authenticationCommand = (): string => "pi";
    constructor() {
        super("MOBIUS_PI_PATH");
    }

    override readonly verifyAcp = async (
        connection: ClientConnection,
        initialized: InitializeResponse,
        defaultWorkspace: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
        if (capabilities.loadSession !== true) {
            throw new AgentProbeError("acp_incompatible", "Pi ACP adapter does not support session recovery");
        }
        const session = await connection.agent.request(
            methods.agent.session.new,
            {
                additionalDirectories: [],
                cwd: defaultWorkspace,
                mcpServers: [],
            },
            { cancellationSignal: signal },
        );
        if (session.sessionId.length === 0) {
            throw new AgentProbeError("acp_incompatible", "Pi ACP adapter returned an invalid session");
        }
        const prompt = await connection.agent.request(
            methods.agent.session.prompt,
            {
                prompt: [{ text: "/session", type: "text" }],
                sessionId: session.sessionId,
            },
            { cancellationSignal: signal },
        );
        if (prompt.stopReason !== "end_turn") {
            throw new AgentProbeError("acp_incompatible", "Pi ACP adapter did not complete its conformance prompt");
        }
    };
}
