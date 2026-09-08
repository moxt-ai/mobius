import { join } from "node:path";

import type { ClientConnection, InitializeResponse } from "@agentclientprotocol/sdk";

import type { ManagedNpmPackageDefinition } from "../agent-installation/managed-npm-package.ts";
import { type ResolvedExecutable, resolveExecutablePath } from "../process/executable.ts";
import type { LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";

const VERSION_PROBE_TIMEOUT_MILLISECONDS = 3_000;
const ACP_PROBE_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_PROMPT_TIMEOUT_MILLISECONDS = 30 * 60 * 1_000;

export abstract class LocalAgentSpecification {
    abstract readonly adapterOverrideVariable: string;
    abstract readonly adapterVersion: string;
    abstract readonly agentExecutable: string;
    abstract readonly agentOverrideVariable: string;
    abstract readonly id: string;
    abstract readonly label: string;
    abstract readonly launchArguments: readonly string[];
    abstract readonly managedAdapterExecutablePath: readonly string[];
    abstract readonly managedAgentExecutablePath: readonly string[];
    readonly acpProbeTimeoutMilliseconds: number = ACP_PROBE_TIMEOUT_MILLISECONDS;
    readonly authenticationCommand = (): string => "";
    readonly adapterVersionArguments: readonly string[] = ["--version"];
    readonly agentVersionArguments: readonly string[] = ["--version"];
    readonly promptTimeoutMilliseconds: number = DEFAULT_PROMPT_TIMEOUT_MILLISECONDS;
    readonly versionProbeTimeoutMilliseconds: number = VERSION_PROBE_TIMEOUT_MILLISECONDS;

    readonly resolveManagedAgent = async (
        stateDirectory: string,
        platform: NodeJS.Platform,
        signal: AbortSignal,
    ): Promise<ResolvedExecutable> => {
        signal.throwIfAborted();
        const executable = await resolveExecutablePath(
            join(stateDirectory, ...this.managedAgentExecutablePath),
            platform,
        );
        signal.throwIfAborted();
        if (executable === null) {
            throw new Error("The managed Agent executable is unavailable");
        }
        return executable;
    };

    readonly createLaunchEnvironment = async (
        _agent: ResolvedExecutable,
        _context: LocalAgentDiscoveryContext,
    ): Promise<Readonly<Record<string, string>>> => Object.freeze({});

    readonly recoveryCommand = (): string => "";

    readonly resolveInstalledAgentExecutables = (
        _context: LocalAgentDiscoveryContext,
    ): Promise<readonly ResolvedExecutable[]> => Promise.resolve([]);

    readonly verifyAcp = (
        _connection: ClientConnection,
        _initialized: InitializeResponse,
        _defaultWorkspace: string,
        _signal: AbortSignal,
    ): Promise<void> => Promise.resolve();
}

export abstract class DirectAcpAgentDefinition extends LocalAgentSpecification {
    readonly adapterOverrideVariable: string;
    readonly agentOverrideVariable: string;
    readonly launchArguments: readonly string[];
    readonly managedAdapterExecutablePath: readonly string[];
    readonly managedAgentExecutablePath: readonly string[];

    protected constructor(
        executableOverrideVariable: string,
        launchArguments: readonly string[],
        managedExecutablePath: readonly string[],
    ) {
        super();
        this.adapterOverrideVariable = executableOverrideVariable;
        this.agentOverrideVariable = executableOverrideVariable;
        this.launchArguments = Object.freeze([...launchArguments]);
        this.managedAdapterExecutablePath = Object.freeze([...managedExecutablePath]);
        this.managedAgentExecutablePath = this.managedAdapterExecutablePath;
    }
}

export abstract class BridgedAcpAgentDefinition extends LocalAgentSpecification {
    abstract readonly adapterEnvironmentVariable: string;
    abstract readonly adapterPackageDefinition: ManagedNpmPackageDefinition;
    readonly launchArguments: readonly string[] = Object.freeze([]);

    get adapterExecutable(): string {
        return this.adapterPackageDefinition.executableName;
    }

    get adapterPackage(): string {
        return this.adapterPackageDefinition.packageName;
    }

    get adapterVersion(): string {
        return this.adapterPackageDefinition.version;
    }

    override readonly createLaunchEnvironment = async (
        agent: ResolvedExecutable,
        _context: LocalAgentDiscoveryContext,
    ): Promise<Readonly<Record<string, string>>> => Object.freeze({ [this.adapterEnvironmentVariable]: agent.path });

    override readonly recoveryCommand = (): string =>
        `npm install -g --omit=optional ${this.adapterPackage}@${this.adapterVersion}`;
}
