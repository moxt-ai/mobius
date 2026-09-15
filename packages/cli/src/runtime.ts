import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { discoverLocalAgentInventory } from "./agent-catalog/discover-local-agents.ts";
import { AuditStore } from "./audit/audit-store.ts";
import { createDaemonConfig, type DaemonConfig, loadDefaultWorkspace } from "./config.ts";
import { runDaemon } from "./run-daemon.ts";
import { readStateDirectory } from "./storage/state-directory.ts";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const RUNTIME_CREDENTIAL_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

export interface MobiusRuntimeConnection {
    readonly auditDatabasePath: string;
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

function validateRuntimeConfiguration(config: DaemonConfig): void {
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
    if (!IDENTIFIER_PATTERN.test(channelId)) {
        throw new MobiusRuntimeConfigurationError("MOBIUS_CHANNEL_ID is invalid");
    }
    return Object.freeze({
        auditDatabasePath:
            environment["MOBIUS_AUDIT_DATABASE"]?.trim() ||
            join(readStateDirectory(environment), "audit", `${channelId}.sqlite`),
        channelId,
        defaultWorkspace: loadDefaultWorkspace(environment),
        relayUrl: requiredEnvironmentValue(environment, "MOBIUS_RELAY_URL"),
        runtimeCredential: requiredEnvironmentValue(environment, "MOBIUS_RELAY_TOKEN"),
    });
}

async function resolveWorkspace(path: string): Promise<string> {
    const requested = resolve(path);
    try {
        await mkdir(requested, { recursive: true, mode: 0o700 });
        const resolved = await realpath(requested);
        const metadata = await stat(resolved);
        if (!metadata.isDirectory()) {
            throw new MobiusRuntimeConfigurationError("The Runtime workspace is not a directory");
        }
        return resolved;
    } catch (error) {
        if (error instanceof MobiusRuntimeConfigurationError) {
            throw error;
        }
        throw new MobiusRuntimeConfigurationError("The Runtime workspace cannot be resolved", { cause: error });
    }
}

export async function createMobiusRuntimeEngine(
    connection: MobiusRuntimeConnection,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<MobiusRuntimeEngine> {
    signal.throwIfAborted();
    const relayUrl = relayUrlFromConnection(connection);
    const defaultWorkspace = await resolveWorkspace(connection.defaultWorkspace);
    const auditDatabasePath = resolve(connection.auditDatabasePath);
    await mkdir(dirname(auditDatabasePath), { recursive: true, mode: 0o700 });
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace,
        environment,
        signal,
    });
    if (inventory.available.length + inventory.installable.length === 0) {
        throw new MobiusRuntimeConfigurationError("No supported Agent is available for the local Runtime");
    }
    return new MobiusRuntimeEngine(
        createDaemonConfig(
            {
                auditDatabasePath,
                channelId: connection.channelId,
                defaultWorkspace,
                relayUrl,
            },
            inventory.readyAgents(),
            inventory.installable,
        ),
    );
}

export class MobiusRuntimeEngine {
    readonly #config: DaemonConfig;
    #state: MobiusRuntimeState = new IdleMobiusRuntimeState();

    constructor(config: DaemonConfig) {
        validateRuntimeConfiguration(config);
        this.#config = config;
    }

    readonly run = async (signal: AbortSignal): Promise<void> => {
        if (!(this.#state instanceof IdleMobiusRuntimeState)) {
            throw new MobiusRuntimeConfigurationError("A Mobius Runtime engine can only be started once");
        }
        signal.throwIfAborted();
        this.#state = new RunningMobiusRuntimeState();
        const audit = new AuditStore(this.#config.auditDatabasePath);
        try {
            await runDaemon(this.#config, audit, signal);
        } finally {
            audit.close();
            this.#state = new FinishedMobiusRuntimeState();
        }
    };
}

export type { DaemonConfig, DaemonConnectionConfig } from "./config.ts";
export { createDaemonConfig } from "./config.ts";
export {
    type MobiusRuntimePairingOptions,
    type PairedDaemon,
    PairingClientError,
    pairMobiusRuntime,
    resumeMobiusRuntime,
} from "./pairing/pair-local-machine.ts";
