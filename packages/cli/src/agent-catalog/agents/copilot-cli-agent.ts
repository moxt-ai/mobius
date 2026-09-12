import type { AgentCapabilities, ClientConnection, InitializeResponse } from "@agentclientprotocol/sdk";

import type { ResolvedExecutable } from "../../process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../agent-discovery-context.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";
import { resolveUserLocalExecutable } from "./resolve-user-local-executable.ts";
import { verifySessionCreation } from "./verify-session-creation.ts";

const COPILOT_CLI_TESTED_VERSION = "1.0.83";

export class CopilotCliAgentSpecification extends DirectAcpAgentDefinition {
    override readonly acpProbeTimeoutMilliseconds = 20_000;
    readonly adapterVersion = COPILOT_CLI_TESTED_VERSION;
    override readonly authenticationCommand = (): string => "copilot login";
    readonly agentExecutable = "copilot";
    readonly id = "github-copilot-cli";
    readonly label = "GitHub Copilot CLI";
    override readonly versionProbeTimeoutMilliseconds = 10_000;

    constructor() {
        super(
            "MOBIUS_COPILOT_PATH",
            ["--no-auto-update", "--acp", "--stdio"],
            ["agents", "github-copilot-cli", COPILOT_CLI_TESTED_VERSION, "bin", "copilot"],
        );
    }

    override readonly createLaunchEnvironment = async (
        _agent: ResolvedExecutable,
        _context: LocalAgentDiscoveryContext,
    ): Promise<Readonly<Record<string, string>>> => Object.freeze({ COPILOT_AUTO_UPDATE: "false" });

    override readonly resolveInstalledAgentExecutables = async (
        context: LocalAgentDiscoveryContext,
    ): Promise<readonly ResolvedExecutable[]> => await resolveUserLocalExecutable(this.agentExecutable, context);

    override readonly verifyAcp = async (
        connection: ClientConnection,
        initialized: InitializeResponse,
        defaultWorkspace: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
        if (
            capabilities.loadSession !== true ||
            capabilities.sessionCapabilities?.list == null ||
            (initialized.authMethods ?? []).length === 0
        ) {
            throw new AgentProbeError(
                "acp_incompatible",
                "GitHub Copilot CLI reported an unsupported ACP capability set",
            );
        }
        await verifySessionCreation(connection, capabilities, defaultWorkspace, signal, this.label);
    };
}
