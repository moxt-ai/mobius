import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
    type AgentCapabilities,
    type ClientConnection,
    type InitializeResponse,
    RequestError,
} from "@agentclientprotocol/sdk";

import { GROK_BUILD_MANAGED_VERSION, grokBuildManagedPackage } from "../../agent-installation/grok-managed-package.ts";
import { validateManagedNpmPackage } from "../../agent-installation/managed-npm-package.ts";
import { type ResolvedExecutable, resolveExecutablePath } from "../../process/executable.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";
import type { LocalAgentDiscoveryContext } from "../agent-discovery-context.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";
import { verifySessionCreation } from "./verify-session-creation.ts";

function isContainedPath(root: string, candidate: string): boolean {
    const difference = relative(root, candidate);
    return (
        difference.length > 0 && difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
    );
}

export class GrokBuildAgentSpecification extends DirectAcpAgentDefinition {
    readonly adapterVersion = GROK_BUILD_MANAGED_VERSION;
    override readonly authenticationCommand = (): string => "grok login";
    readonly agentExecutable = "grok";
    override readonly agentVersionArguments: readonly string[] = ["version"];
    override readonly adapterVersionArguments: readonly string[] = ["version"];
    readonly id = "grok-build";
    readonly label = "Grok Build";
    override readonly minimumSupportedAgentVersion = GROK_BUILD_MANAGED_VERSION;
    override readonly maximumTestedAgentVersion = GROK_BUILD_MANAGED_VERSION;

    constructor() {
        super(
            "MOBIUS_GROK_BUILD_PATH",
            ["--no-auto-update", "agent", "stdio"],
            ["agents", "grok-build", GROK_BUILD_MANAGED_VERSION, "home", "bin", "grok"],
        );
    }

    override readonly createLaunchEnvironment = async (
        agent: ResolvedExecutable,
        context: LocalAgentDiscoveryContext,
    ): Promise<Readonly<Record<string, string>>> => {
        const stateDirectory = readStateDirectory(context.environment);
        try {
            const managed = await this.resolveManagedAgent(
                stateDirectory,
                context.platform ?? process.platform,
                context.signal,
            );
            if (managed.path === agent.path) {
                return Object.freeze({
                    GROK_HOME: await realpath(
                        join(stateDirectory, "agents", this.id, GROK_BUILD_MANAGED_VERSION, "home"),
                    ),
                });
            }
        } catch {
            context.signal.throwIfAborted();
            // An unavailable managed package cannot select the managed Grok home.
        }
        return Object.freeze({});
    };

    override readonly resolveManagedAgent = async (
        stateDirectory: string,
        platform: NodeJS.Platform,
        signal: AbortSignal,
    ): Promise<ResolvedExecutable> => {
        signal.throwIfAborted();
        const versionRoot = await realpath(join(stateDirectory, "agents", this.id, GROK_BUILD_MANAGED_VERSION));
        await validateManagedNpmPackage(join(versionRoot, "package"), grokBuildManagedPackage(platform, process.arch));
        const executable = await resolveExecutablePath(join(versionRoot, "home", "bin", "grok"), platform);
        signal.throwIfAborted();
        if (executable === null || !isContainedPath(versionRoot, executable.path)) {
            throw new AgentProbeError("managed_agent_invalid", "The managed Grok Build executable is invalid");
        }
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
            throw new AgentProbeError("acp_incompatible", "Grok Build did not report ACP session loading");
        }
        const authMethods = initialized.authMethods ?? [];
        if (authMethods.length === 0) {
            throw new AgentProbeError("acp_incompatible", "Grok Build did not report an ACP authentication method");
        }
        try {
            await verifySessionCreation(connection, capabilities, defaultWorkspace, signal, this.label);
        } catch (cause) {
            const detail =
                cause instanceof RequestError
                    ? `ACP error ${cause.code}: ${cause.message}`
                    : cause instanceof Error
                      ? `${cause.name}: ${cause.message}`
                      : "unknown error";
            throw new AgentProbeError(
                "acp_incompatible",
                `Grok Build could not create an ACP session (${detail}; auth methods: ${authMethods.map(({ id }) => id).join(", ")})`,
                { cause },
            );
        }
    };
}
