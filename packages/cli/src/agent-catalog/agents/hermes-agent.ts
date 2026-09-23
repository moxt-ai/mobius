import type { AgentCapabilities, ClientConnection, InitializeResponse } from "@agentclientprotocol/sdk";

import type { ResolvedExecutable } from "../../process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../agent-discovery-context.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";
import { resolveUserLocalExecutable } from "./resolve-user-local-executable.ts";
import { verifySessionCreation } from "./verify-session-creation.ts";

const HERMES_TESTED_VERSION = "0.21.1";

export class HermesAgentSpecification extends DirectAcpAgentDefinition {
    override readonly acpProbeTimeoutMilliseconds = 20_000;
    readonly adapterVersion = HERMES_TESTED_VERSION;
    override readonly adapterVersionArguments: readonly string[] = ["acp", "--version"];
    override readonly authenticationCommand = (): string => "hermes acp --setup";
    readonly agentExecutable = "hermes";
    override readonly agentVersionArguments: readonly string[] = ["acp", "--version"];
    readonly id = "hermes";
    readonly label = "Hermes Agent";

    constructor() {
        super("MOBIUS_HERMES_PATH", ["acp"], ["agents", "hermes", HERMES_TESTED_VERSION, "bin", "hermes"]);
    }

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
        const session = capabilities.sessionCapabilities;
        if (
            capabilities.loadSession !== true ||
            session?.fork == null ||
            session.list == null ||
            session.resume == null ||
            (initialized.authMethods ?? []).length === 0
        ) {
            throw new AgentProbeError("acp_incompatible", "Hermes Agent reported an unsupported ACP capability set");
        }
        await verifySessionCreation(connection, capabilities, defaultWorkspace, signal, this.label);
    };
}
