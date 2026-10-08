import { join } from "node:path";

import {
    type AgentCapabilities,
    type ClientConnection,
    type InitializeResponse,
    methods,
} from "@agentclientprotocol/sdk";

import { validateManagedNpmPackage } from "../../agent-installation/managed-npm-package.ts";
import { PI_ACP_PACKAGE, PI_AGENT_PACKAGE } from "../../agent-installation/pi-managed-packages.ts";
import type { ResolvedExecutable } from "../../process/executable.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { BridgedAcpAgentDefinition } from "../agent-specification.ts";

const ACP_PROBE_TIMEOUT_MILLISECONDS = 30_000;

export class PiAgentSpecification extends BridgedAcpAgentDefinition {
    override readonly acpProbeTimeoutMilliseconds = ACP_PROBE_TIMEOUT_MILLISECONDS;
    readonly adapterEnvironmentVariable = "PI_ACP_PI_COMMAND";
    readonly adapterOverrideVariable = "MOBIUS_PI_ACP_PATH";
    readonly adapterPackageDefinition = PI_ACP_PACKAGE;
    override readonly adapterVersionArguments: readonly string[] = [];
    override readonly authenticationCommand = (): string => "pi-acp --terminal-login";
    readonly agentExecutable = "pi";
    readonly agentOverrideVariable = "MOBIUS_PI_PATH";
    readonly id = "pi";
    readonly label = "Pi";
    override readonly minimumSupportedAgentVersion = "0.85.0";
    override readonly maximumTestedAgentVersion = PI_AGENT_PACKAGE.version;
    readonly managedAdapterExecutablePath = [
        "adapters",
        "pi",
        PI_ACP_PACKAGE.version,
        "node_modules",
        "pi-acp",
        "dist",
        "index.js",
    ];
    readonly managedAgentExecutablePath = [
        "agents",
        "pi",
        PI_AGENT_PACKAGE.version,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "bundle",
        "cli.js",
    ];
    override readonly resolveManagedAgent = async (
        stateDirectory: string,
        _platform: NodeJS.Platform,
        signal: AbortSignal,
    ): Promise<ResolvedExecutable> => {
        signal.throwIfAborted();
        const executable = await validateManagedNpmPackage(
            join(stateDirectory, "agents", this.id, PI_AGENT_PACKAGE.version),
            PI_AGENT_PACKAGE,
        );
        signal.throwIfAborted();
        return executable;
    };

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
