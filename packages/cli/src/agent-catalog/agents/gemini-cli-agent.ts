import type { AgentCapabilities, ClientConnection, InitializeResponse } from "@agentclientprotocol/sdk";

import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";
import { verifySessionCreation } from "./verify-session-creation.ts";

const GEMINI_CLI_TESTED_VERSION = "0.59.0";

export class GeminiCliAgentSpecification extends DirectAcpAgentDefinition {
    override readonly acpProbeTimeoutMilliseconds = 20_000;
    readonly adapterVersion = GEMINI_CLI_TESTED_VERSION;
    override readonly authenticationCommand = (): string => "gemini";
    readonly agentExecutable = "gemini";
    readonly id = "gemini-cli";
    readonly label = "Gemini CLI";
    override readonly versionProbeTimeoutMilliseconds = 10_000;

    constructor() {
        super(
            "MOBIUS_GEMINI_PATH",
            ["--acp"],
            [
                "agents",
                "gemini-cli",
                GEMINI_CLI_TESTED_VERSION,
                "bin",
                process.platform === "win32" ? "gemini.cmd" : "gemini",
            ],
        );
    }

    override readonly verifyAcp = async (
        connection: ClientConnection,
        initialized: InitializeResponse,
        defaultWorkspace: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
        if (capabilities.loadSession !== true || (initialized.authMethods ?? []).length === 0) {
            throw new AgentProbeError("acp_incompatible", "Gemini CLI reported an unsupported ACP capability set");
        }
        await verifySessionCreation(connection, capabilities, defaultWorkspace, signal, this.label);
    };
}
