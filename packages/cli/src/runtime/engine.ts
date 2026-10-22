import { resolve } from "node:path";
import { isIdentifier, type RuntimeUpgradeResult } from "@moxt-ai/mobius-sdk/protocol";
import {
    discoverLocalAgentInventory,
    supportedLocalAgentSpecifications,
} from "../agent/discovery/discover-local-agents.ts";
import { ensureCanonicalDirectory } from "../storage/files/local-files.ts";
import { readStateDirectory } from "../storage/state-directory.ts";
import { publishAgentCatalog } from "./catalog/publish-agent-catalog.ts";
import { createCatalogAgentResolver } from "./catalog/resolve-catalog-agent.ts";
import { createRuntimeConfig, loadDefaultWorkspace, type RuntimeConfig, RuntimeLocalContext } from "./config.ts";
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

abstract class MobiusRuntimeState {}

class IdleMobiusRuntimeState extends MobiusRuntimeState {}

class RunningMobiusRuntimeState extends MobiusRuntimeState {}

class FinishedMobiusRuntimeState extends MobiusRuntimeState {}

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

function requiredEnvironmentValue(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
    const value = environment[name]?.trim();
    if (value === undefined || value.length === 0) {
        throw new MobiusRuntimeConfigurationError(`${name} is required`);
    }
    return value;
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

export function loadMobiusRuntimeConnection(
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): MobiusRuntimeConnection {
    const channelId = requiredEnvironmentValue(environment, "MOBIUS_CHANNEL_ID");
    if (!isIdentifier(channelId)) {
        throw new MobiusRuntimeConfigurationError("MOBIUS_CHANNEL_ID is invalid");
    }
    return Object.freeze({
        channelId,
        defaultWorkspace: loadDefaultWorkspace(environment),
        relayUrl: requiredEnvironmentValue(environment, "MOBIUS_RELAY_URL"),
        runtimeCredential: requiredEnvironmentValue(environment, "MOBIUS_RELAY_TOKEN"),
    });
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

export async function createMobiusRuntimeEngine(
    connection: MobiusRuntimeConnection,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<MobiusRuntimeEngine> {
    signal.throwIfAborted();
    const localContext = new RuntimeLocalContext(readStateDirectory(environment), environment);
    const relayUrl = relayUrlFromConnection(connection);
    const defaultWorkspace = await resolveWorkspace(connection.defaultWorkspace);
    const specifications = supportedLocalAgentSpecifications();
    const discoveryEnvironment = localContext.environment;
    const discover = async (refreshSignal: AbortSignal) =>
        await discoverLocalAgentInventory({
            defaultWorkspace,
            environment: discoveryEnvironment,
            signal: refreshSignal,
            specifications,
        });
    const inventory = await discover(signal);
    const config: RuntimeConfig = createRuntimeConfig(
        {
            channelId: connection.channelId,
            defaultWorkspace,
            relayUrl,
        },
        inventory.readyAgents(),
        localContext,
        null,
        createCatalogAgentResolver(
            (refreshSignal) => discover(refreshSignal),
            () => config,
            publishAgentCatalog,
        ),
    );
    return new MobiusRuntimeEngine(config);
}

export class MobiusRuntimeEngine {
    readonly #config: RuntimeConfig;
    readonly #options: MobiusRuntimeEngineOptions;
    #state: MobiusRuntimeState = new IdleMobiusRuntimeState();

    constructor(config: RuntimeConfig, options: MobiusRuntimeEngineOptions = {}) {
        validateRuntimeConfiguration(config);
        this.#config = config;
        this.#options = options;
    }

    readonly run = async (signal: AbortSignal): Promise<void> => {
        if (!(this.#state instanceof IdleMobiusRuntimeState)) {
            throw new MobiusRuntimeConfigurationError("A Mobius Runtime engine can only be started once");
        }
        signal.throwIfAborted();
        this.#state = new RunningMobiusRuntimeState();
        try {
            await runRuntime(this.#config, signal, undefined, {
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
            this.#state = new FinishedMobiusRuntimeState();
        }
    };
}

export interface MobiusRuntimeEngineOptions {
    readonly onConnectionStatus?: (status: "online" | "reconnecting") => void;
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

export type { RuntimeConfig, RuntimeConnectionConfig } from "./config.ts";
export {
    createRuntimeConfig,
    OpaqueRuntimeReconnectTarget,
    RuntimeLocalContext,
    RuntimeReconnectTarget,
} from "./config.ts";
export { type RuntimeConnectionInput, VerifiedRuntimeConnection } from "./connection/runtime-connection.ts";
export {
    openRuntimeInstallationStore,
    RuntimeInstallationStore,
    RuntimeInstallationStoreError,
    type RuntimeInstallationStoreOptions,
} from "./connection/runtime-installation-store.ts";
export { RuntimeRelayRevokedError } from "./relay/runtime-revocation.ts";
