import {
    type AgentCapabilities,
    type ClientConnection,
    type InitializeResponse,
    methods,
} from "@agentclientprotocol/sdk";

import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";

const ACP_PROBE_TIMEOUT_MILLISECONDS = 30_000;

const OH_MY_PI_TESTED_VERSION = "18.2.7";

export class OhMyPiAgentSpecification extends DirectAcpAgentDefinition {
    override readonly acpProbeTimeoutMilliseconds = ACP_PROBE_TIMEOUT_MILLISECONDS;
    override readonly adapterVersion = OH_MY_PI_TESTED_VERSION;
    override readonly authenticationCommand = (): string => "omp";
    override readonly agentExecutable = "omp";
    override readonly agentOverrideVariable = "MOBIUS_OH_MY_PI_PATH";
    readonly id = "oh-my-pi";
    readonly label = "Oh My Pi";
    override readonly minimumSupportedAgentVersion = OH_MY_PI_TESTED_VERSION;
    override readonly maximumTestedAgentVersion = OH_MY_PI_TESTED_VERSION;

    constructor() {
        super("MOBIUS_OH_MY_PI_PATH", ["acp"], ["agents", "oh-my-pi", OH_MY_PI_TESTED_VERSION, "bin", "omp"]);
    }

    override readonly verifyAcp = async (
        connection: ClientConnection,
        initialized: InitializeResponse,
        defaultWorkspace: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
        if (capabilities.loadSession !== true) {
            throw new AgentProbeError("acp_incompatible", "Oh My Pi does not support ACP session recovery");
        }
        const session = await connection.agent.request(
            methods.agent.session.new,
            { additionalDirectories: [], cwd: defaultWorkspace, mcpServers: [] },
            { cancellationSignal: signal },
        );
        if (session.sessionId.length === 0) {
            throw new AgentProbeError("acp_incompatible", "Oh My Pi returned an invalid ACP session");
        }
        const prompt = await connection.agent.request(
            methods.agent.session.prompt,
            { prompt: [{ text: "/session", type: "text" }], sessionId: session.sessionId },
            { cancellationSignal: signal },
        );
        if (prompt.stopReason !== "end_turn") {
            throw new AgentProbeError("acp_incompatible", "Oh My Pi did not complete its ACP conformance prompt");
        }
    };
}
