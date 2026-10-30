import { resolve } from "node:path";
import type { RuntimeUpgradeResult } from "@moxt-ai/mobius-sdk/protocol";
import { supportedLocalAgentSpecifications } from "../agent/discovery/discover-local-agents.ts";
import { RuntimeAgentDependencies } from "../agent/runtime-agents.ts";
import type { RuntimeAgentProcesses } from "../session/process/runtime-agent-processes.ts";
import type { RuntimeTurnActivity } from "../session/turn/runtime-turn-activity.ts";
import { ensureCanonicalDirectory } from "../storage/files/local-files.ts";
import { discoverRuntimeAgentInventory } from "./catalog/discover-agent-catalog.ts";
import { publishAgentCatalog } from "./catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "./catalog/resolve-catalog-agent.ts";
import { createRuntimeConfig, type RuntimeConfig, RuntimeLocalContext } from "./config.ts";
import type { RuntimeInstallationStore } from "./connection/runtime-installation-store.ts";
import { runRuntime } from "./run.ts";

const RUNTIME_CREDENTIAL_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

export interface MobiusRuntimeConnection {
    readonly channelId: string;
    readonly defaultWorkspace: string;
    readonly relayUrl: string;
    readonly runtimeCredential: string;
}

export class MobiusRuntimeConfigurationError extends Error {
    readonly code = "runtime_configuration_invalid";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "MobiusRuntimeConfigurationError";
    }
}

type RuntimeLoopState =
    | { readonly kind: "created" }
    | { readonly kind: "preparing" }
    | { readonly kind: "running"; readonly config: RuntimeConfig }
    | { readonly kind: "finished" };

function validateRuntimeRelay(relayUrl: URL): void {
    if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
        throw new MobiusRuntimeConfigurationError("The Runtime relay URL must use WebSocket transport");
    }
    const credential = relayUrl.searchParams.get("token") ?? "";
    if (credential.length === 0) {
        throw new MobiusRuntimeConfigurationError("The Runtime relay credential is required");
    }
    if (!RUNTIME_CREDENTIAL_PATTERN.test(credential)) {
        throw new MobiusRuntimeConfigurationError("The Runtime relay credential is invalid");
    }
}

function validateRuntimeConfiguration(config: RuntimeConfig): void {
    validateRuntimeRelay(config.relayUrl);
}

function relayUrlFromConnection(connection: MobiusRuntimeConnection): URL {
    let relayUrl: URL;
    try {
        relayUrl = new URL(connection.relayUrl);
    } catch (error) {
        throw new MobiusRuntimeConfigurationError("The Runtime relay URL is invalid", { cause: error });
    }
    relayUrl.searchParams.set("token", connection.runtimeCredential);
    validateRuntimeRelay(relayUrl);
    return relayUrl;
}

async function resolveWorkspace(path: string): Promise<string> {
    const requested = resolve(path);
    let resolved: string | null;
    try {
        resolved = await ensureCanonicalDirectory(requested);
    } catch (error) {
        throw new MobiusRuntimeConfigurationError("The Runtime workspace cannot be resolved", { cause: error });
    }
    if (resolved === null) {
        throw new MobiusRuntimeConfigurationError("The Runtime workspace is not a directory");
    }
    return resolved;
}

interface PrepareProvidedRuntimeParams {
    readonly installation: RuntimeInstallationStore;
    readonly connection: MobiusRuntimeConnection;
    readonly signal: AbortSignal;
    readonly agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly maxAcpProcesses: number;
}

export async function prepareProvidedRuntime({
    installation,
    connection,
    signal,
    agentLaunchEnvironment,
    maxAcpProcesses,
}: PrepareProvidedRuntimeParams): Promise<RuntimeConfig> {
    signal.throwIfAborted();
    const relayUrl = relayUrlFromConnection(connection);
    const localContext = new RuntimeLocalContext(installation.stateDirectory, agentLaunchEnvironment, maxAcpProcesses);
    const defaultWorkspace = await resolveWorkspace(connection.defaultWorkspace);
    const specifications = supportedLocalAgentSpecifications();
    const discoveryEnvironment = localContext.agentLaunchEnvironment;
    const discover = async (refreshSignal: AbortSignal) =>
        await discoverRuntimeAgentInventory(
            {
                defaultWorkspace,
                dataDirectory: localContext.stateDirectory,
                environment: discoveryEnvironment,
                signal: refreshSignal,
                specifications,
            },
            connection.channelId,
        );
    const inventory = await discover(signal);
    const config: RuntimeConfig = createRuntimeConfig(
        {
            channelId: connection.channelId,
            defaultWorkspace,
            relayUrl,
        },
        new RuntimeAgentDependencies(inventory.readyAgents()),
        localContext,
        null,
        createCatalogAgentResolver(
            (refreshSignal) => discover(refreshSignal),
            () => config,
            publishAgentCatalog,
        ),
        (refreshSignal: AbortSignal) => discover(refreshSignal).then((inventory) => inventory.readyAgents()),
    );
    return config;
}

/** Internal, single-execution owner. Never exported from the package's public API. */
export class RuntimeLoop {
    readonly #prepare: (signal: AbortSignal) => Promise<RuntimeConfig>;
    readonly #options: RuntimeLoopOptions;
    #state: RuntimeLoopState = { kind: "created" };

    constructor(prepare: (signal: AbortSignal) => Promise<RuntimeConfig>, options: RuntimeLoopOptions = {}) {
        this.#prepare = prepare;
        this.#options = options;
    }

    readonly run = async (signal: AbortSignal): Promise<void> => {
        if (this.#state.kind !== "created") {
            throw new MobiusRuntimeConfigurationError("A Runtime loop can only be started once");
        }
        signal.throwIfAborted();
        // Claim this execution before asynchronous preparation can yield.
        this.#state = { kind: "preparing" };
        try {
            const prepared = await this.#prepare(signal);
            signal.throwIfAborted();
            const config =
                this.#options.sessionEnvironment === undefined
                    ? prepared
                    : { ...prepared, sessionEnvironment: this.#options.sessionEnvironment };
            validateRuntimeConfiguration(config);
            this.#state = { kind: "running", config };
            await runRuntime(config, signal, undefined, {
                ...(this.#options.turnActivity === undefined ? {} : { turnActivity: this.#options.turnActivity }),
                ...(this.#options.agentProcesses === undefined ? {} : { agentProcesses: this.#options.agentProcesses }),
                onExecutionCountChange: (count) => {
                    this.#options.onExecutionCountChange?.(count);
                },
                ...(this.#options.onConnectionStatus === undefined
                    ? {}
                    : { onConnectionStatus: this.#options.onConnectionStatus }),
                ...(this.#options.reportUpgradeAvailability === undefined
                    ? {}
                    : { reportUpgradeAvailability: this.#options.reportUpgradeAvailability }),
                ...(this.#options.processLogsDirectory === undefined
                    ? {}
                    : { processLogsDirectory: this.#options.processLogsDirectory }),
            });
        } finally {
            this.#state = { kind: "finished" };
            this.#options.onExecutionCountChange?.(0);
        }
    };
}

export interface RuntimeLoopOptions {
    /** Session-scoped Agent environment for this execution only; never persisted with the connection. */
    readonly sessionEnvironment?: RuntimeConfig["sessionEnvironment"];
    readonly turnActivity?: RuntimeTurnActivity;
    readonly agentProcesses?: RuntimeAgentProcesses;
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
    readonly onExecutionCountChange?: (count: number) => void;
    /** Reports a finished daemon upgrade to the relay. The daemon worker supplies it. */
    readonly reportUpgradeAvailability?: (
        send: (result: RuntimeUpgradeResult) => void,
        signal: AbortSignal,
    ) => Promise<void>;
    /**
     * State directory of the daemon processes supervising this Runtime. Passed
     * through to `runRuntime` so the local bug-report log can read the
     * manager-written worker lifecycle and unhandled-rejection logs. Read-only.
     */
    readonly processLogsDirectory?: string;
}
