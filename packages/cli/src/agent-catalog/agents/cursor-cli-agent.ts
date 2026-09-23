import type { AgentCapabilities, ClientConnection, InitializeResponse } from "@agentclientprotocol/sdk";

import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";
import { verifySessionCreation } from "./verify-session-creation.ts";

const CURSOR_CLI_TESTED_VERSION = "2026.09.15-d2fe57e";

export class CursorCliAgentSpecification extends DirectAcpAgentDefinition {
    readonly adapterVersion = CURSOR_CLI_TESTED_VERSION;
    override readonly authenticationCommand = (): string => "cursor-agent login";
    readonly agentExecutable = "cursor-agent";
    readonly id = "cursor";
    readonly label = "Cursor CLI";
    override readonly minimumSupportedAgentVersion = CURSOR_CLI_TESTED_VERSION;
    override readonly maximumTestedAgentVersion = CURSOR_CLI_TESTED_VERSION;

    constructor() {
        super(
            "MOBIUS_CURSOR_PATH",
            ["--disable-auto-update", "acp"],
            ["agents", "cursor", CURSOR_CLI_TESTED_VERSION, "bin", "cursor-agent"],
        );
    }

    override readonly verifyAcp = async (
        connection: ClientConnection,
        initialized: InitializeResponse,
        defaultWorkspace: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
        if (capabilities.loadSession !== true || capabilities.sessionCapabilities?.list == null) {
            throw new AgentProbeError("acp_incompatible", "Cursor CLI reported an unsupported ACP capability set");
        }
        await verifySessionCreation(connection, capabilities, defaultWorkspace, signal, this.label);
    };
}
