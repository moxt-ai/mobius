import type { ClientConnection, InitializeResponse } from "@agentclientprotocol/sdk";

import type { InProcessAcpEndpointFactory } from "../acp/in-process/acp-endpoint.ts";
import type { ResolvedExecutable } from "../util/process/executable.ts";
import type { LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import { normalizeVersionOutput } from "./version-output.ts";

// A probe budget is the machine's worst-case allowance, not an optimistic guess. An Agent that is
// installed and healthy must not be reclassified as missing just because a cold start, a first-run
// package unpack, or a busy host pushed a single `--version` past a tight deadline. These values are
// deliberately generous; the caller's own deadline (Agent discovery, settings discovery) remains the
// backstop that stops a genuinely hung executable.
const VERSION_PROBE_TIMEOUT_MILLISECONDS = 30_000;
const ACP_PROBE_TIMEOUT_MILLISECONDS = 60_000;

export abstract class LocalAgentSpecification {
    abstract readonly adapterOverrideVariable: string;
    abstract readonly adapterVersion: string;
    abstract readonly agentExecutable: string;
    abstract readonly agentOverrideVariable: string;
    abstract readonly id: string;
    abstract readonly label: string;
    abstract readonly launchArguments: readonly string[];
    readonly minimumSupportedAgentVersion: string = "0.0.0";
    readonly maximumTestedAgentVersion: string = "0.0.0";
    readonly acpProbeTimeoutMilliseconds: number = ACP_PROBE_TIMEOUT_MILLISECONDS;
    readonly authenticationCommand = (): string => "";
    readonly adapterVersionArguments: readonly string[] = ["--version"];
    readonly agentVersionArguments: readonly string[] = ["--version"];
    readonly normalizeAdapterVersion = normalizeVersionOutput;
    readonly normalizeAgentVersion = normalizeVersionOutput;
    readonly versionProbeTimeoutMilliseconds: number = VERSION_PROBE_TIMEOUT_MILLISECONDS;

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

    protected constructor(executableOverrideVariable: string, launchArguments: readonly string[]) {
        super();
        this.adapterOverrideVariable = executableOverrideVariable;
        this.agentOverrideVariable = executableOverrideVariable;
        this.launchArguments = Object.freeze([...launchArguments]);
    }
}

/**
 * A vendor CLI that does not speak ACP, which Mobius drives through the vendor's own protocol from an
 * ACP Agent hosted inside the daemon. There is no adapter to install or version-probe: the same
 * executable is both the Agent and the thing Mobius spawns, so it shares the Agent's override
 * variable.
 *
 * `createEndpoint` is the whole vendor contract. Discovery, the readiness probe, and the session
 * manager use it without naming an Agent, so adding an in-process Agent stays a registration rather
 * than an edit to generic code.
 */
export abstract class InProcessAcpAgentDefinition extends LocalAgentSpecification {
    abstract readonly createEndpoint: InProcessAcpEndpointFactory;
    readonly launchArguments: readonly string[] = Object.freeze([]);
    readonly adapterOverrideVariable: string;
    readonly adapterVersion = "in-process";
    readonly agentOverrideVariable: string;

    protected constructor(executableOverrideVariable: string) {
        super();
        this.adapterOverrideVariable = executableOverrideVariable;
        this.agentOverrideVariable = executableOverrideVariable;
    }
}
