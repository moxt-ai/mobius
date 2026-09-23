import { isAbsolute, join } from "node:path";

import type { AgentCapabilities, ClientConnection, InitializeResponse } from "@agentclientprotocol/sdk";
import { validateManagedNpmPackage } from "../../agent-installation/managed-npm-package.ts";
import {
    WORKBUDDY_MANAGED_PACKAGE,
    WORKBUDDY_MANAGED_VERSION,
} from "../../agent-installation/workbuddy-managed-package.ts";
import { type ResolvedExecutable, resolveExecutablePath } from "../../process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../agent-discovery-context.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";
import { verifySessionCreation } from "./verify-session-creation.ts";

const WORKBUDDY_MACOS_EXECUTABLE_PATH = Object.freeze([
    "WorkBuddy.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "cli",
    "bin",
    "codebuddy",
]);

export class WorkBuddyAgentSpecification extends DirectAcpAgentDefinition {
    readonly adapterVersion = WORKBUDDY_MANAGED_VERSION;
    override readonly authenticationCommand = (): string => "codebuddy";
    readonly agentExecutable = "codebuddy";
    readonly id = "workbuddy";
    readonly label = "WorkBuddy";

    constructor() {
        super(
            "MOBIUS_WORKBUDDY_PATH",
            ["--acp"],
            [
                "agents",
                "workbuddy",
                WORKBUDDY_MANAGED_VERSION,
                "node_modules",
                "@tencent-ai",
                "codebuddy-code",
                "bin",
                "codebuddy",
            ],
        );
    }

    override readonly createLaunchEnvironment = (): Promise<Readonly<Record<string, string>>> =>
        Promise.resolve(Object.freeze({ DISABLE_AUTOUPDATER: "1" }));

    override readonly resolveManagedAgent = async (
        stateDirectory: string,
        _platform: NodeJS.Platform,
        signal: AbortSignal,
    ): Promise<ResolvedExecutable> => {
        signal.throwIfAborted();
        const executable = await validateManagedNpmPackage(
            join(stateDirectory, "agents", this.id, WORKBUDDY_MANAGED_VERSION),
            WORKBUDDY_MANAGED_PACKAGE,
        );
        signal.throwIfAborted();
        return executable;
    };

    override readonly resolveInstalledAgentExecutables = async (
        context: LocalAgentDiscoveryContext,
    ): Promise<readonly ResolvedExecutable[]> => {
        context.signal.throwIfAborted();
        if ((context.platform ?? process.platform) !== "darwin") {
            return [];
        }
        const requestedPaths = [join("/Applications", ...WORKBUDDY_MACOS_EXECUTABLE_PATH)];
        const homeDirectory = context.environment["HOME"];
        if (homeDirectory !== undefined && isAbsolute(homeDirectory)) {
            requestedPaths.unshift(join(homeDirectory, "Applications", ...WORKBUDDY_MACOS_EXECUTABLE_PATH));
        }
        const executables: ResolvedExecutable[] = [];
        for (const requestedPath of requestedPaths) {
            const executable = await resolveExecutablePath(requestedPath, "darwin");
            context.signal.throwIfAborted();
            if (executable !== null) {
                executables.push(executable);
            }
        }
        return executables;
    };

    override readonly verifyAcp = async (
        connection: ClientConnection,
        initialized: InitializeResponse,
        defaultWorkspace: string,
        signal: AbortSignal,
    ): Promise<void> => {
        const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
        if (capabilities.loadSession !== true || (initialized.authMethods ?? []).length === 0) {
            throw new AgentProbeError("acp_incompatible", "WorkBuddy reported an unsupported ACP capability set");
        }
        await verifySessionCreation(connection, capabilities, defaultWorkspace, signal, this.label);
    };
}
