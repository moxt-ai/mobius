import { join } from "node:path";

import type { AgentCapabilities, ClientConnection, InitializeResponse } from "@agentclientprotocol/sdk";

import { validateManagedAgentArchive } from "../../agent-installation/managed-agent-archive.ts";
import { OPENCODE_MANAGED_VERSION, openCodeManagedArchive } from "../../agent-installation/opencode-managed-release.ts";
import type { ResolvedExecutable } from "../../process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../agent-discovery-context.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";

export class OpenCodeAgentSpecification extends DirectAcpAgentDefinition {
    override readonly versionProbeTimeoutMilliseconds = 15_000;
    readonly adapterVersion = OPENCODE_MANAGED_VERSION;
    override readonly authenticationCommand = (): string => "opencode auth login";
    readonly agentExecutable = "opencode";
    readonly id = "opencode";
    readonly label = "OpenCode";

    constructor() {
        super(
            "MOBIUS_OPENCODE_PATH",
            ["acp"],
            [
                "agents",
                "opencode",
                OPENCODE_MANAGED_VERSION,
                "bin",
                process.platform === "win32" ? "opencode.exe" : "opencode",
            ],
        );
    }

    override readonly createLaunchEnvironment = async (
        _agent: ResolvedExecutable,
        _context: LocalAgentDiscoveryContext,
    ): Promise<Readonly<Record<string, string>>> => Object.freeze({ OPENCODE_DISABLE_AUTOUPDATE: "1" });

    override readonly resolveManagedAgent = async (
        stateDirectory: string,
        platform: NodeJS.Platform,
        signal: AbortSignal,
    ): Promise<ResolvedExecutable> =>
        await validateManagedAgentArchive(
            join(stateDirectory, "agents", this.id, OPENCODE_MANAGED_VERSION),
            openCodeManagedArchive(platform, process.arch),
            signal,
        );

    override readonly verifyAcp = (
        _connection: ClientConnection,
        initialized: InitializeResponse,
        _defaultWorkspace: string,
        _signal: AbortSignal,
    ): Promise<void> => {
        const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
        const session = capabilities.sessionCapabilities;
        if (
            capabilities.loadSession !== true ||
            session?.close == null ||
            session.list == null ||
            session.resume == null
        ) {
            throw new AgentProbeError(
                "acp_incompatible",
                "OpenCode does not support the required ACP session lifecycle",
            );
        }
        return Promise.resolve();
    };
}
