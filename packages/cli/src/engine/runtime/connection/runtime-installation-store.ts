import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { ensurePrivateDirectory } from "../../storage/files/local-files.ts";
import {
    applicationDirectory as applicationDirectoryPath,
    channelIndexFilePath,
    connectionDirectory,
    connectionFilePath,
    createInstallationFile,
    type InstallationDirectory,
    installationDirectory,
    installationPointerPath,
    listInstallationFiles,
    readInstallationFile,
    removeInstallationFile,
    writeInstallationFile,
} from "../../storage/installation/installation-files.ts";
import { validateLocalPath } from "../../util/filesystem/private-path.ts";
import { isNodeError } from "../../util/node-error.ts";
import {
    type RuntimeConnectionActivation,
    type RuntimeConnectionInput,
    VerifiedRuntimeConnection,
} from "./runtime-connection.ts";

const APPLICATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,31}$/;
const CONNECTION_ID_PATTERN = /^mcn_[a-f0-9]{32}$/;
const INSTALLATION_ID_PATTERN = /^min_[a-f0-9]{32}$/;
const RUNTIME_CREDENTIAL_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const INSTALLATION_POINTER_KEYS: readonly string[] = ["installationId", "version"];
const CHANNEL_INDEX_KEYS: readonly string[] = [
    "applicationId",
    "channelId",
    "connectionId",
    "installationId",
    "version",
];
const VERIFIED_CONNECTION_KEYS: readonly string[] = [
    "activation",
    "appId",
    "applicationId",
    "channelId",
    "connectionId",
    "defaultWorkspace",
    "installationId",
    "kind",
    "pairingId",
    "relayOrigin",
    "runtimeCredential",
    "runtimeId",
    "version",
];

export interface RuntimeInstallationStoreOptions {
    readonly applicationId: string;
    readonly stateDirectory: string;
}

export class RuntimeInstallationStoreError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "RuntimeInstallationStoreError";
    }
}

interface InstallationPointer {
    readonly installationId: string;
}

interface ChannelIndex {
    readonly applicationId: string;
    readonly channelId: string;
    readonly connectionId: string;
    readonly installationId: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function validateApplicationId(value: string): string {
    if (!APPLICATION_ID_PATTERN.test(value)) {
        throw new RuntimeInstallationStoreError("invalid_application_id", "The application ID is invalid");
    }
    return value;
}

function validateRemoteAppId(value: string): string {
    if (!isIdentifier(value)) {
        throw new RuntimeInstallationStoreError("invalid_app_id", "The remote App ID is invalid");
    }
    return value;
}

function validateConnectionId(value: string): string {
    if (!CONNECTION_ID_PATTERN.test(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection_id", "The local connection ID is invalid");
    }
    return value;
}

function validateInstallationId(value: string): string {
    if (!INSTALLATION_ID_PATTERN.test(value)) {
        throw new RuntimeInstallationStoreError("invalid_installation_id", "The installation ID is invalid");
    }
    return value;
}

function validateIdentifier(value: string, code: string): string {
    if (!isIdentifier(value)) {
        throw new RuntimeInstallationStoreError(code, "The saved Runtime connection is invalid");
    }
    return value;
}

function validateRuntimeCredential(value: string): string {
    if (!RUNTIME_CREDENTIAL_PATTERN.test(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return value;
}

function parseRelayOrigin(value: string): URL {
    let origin: URL;
    try {
        origin = new URL(value);
    } catch (cause) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid", {
            cause,
        });
    }
    if (
        (origin.protocol !== "https:" && origin.protocol !== "http:") ||
        origin.username.length > 0 ||
        origin.password.length > 0 ||
        (origin.protocol === "http:" && origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost")
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    origin.hash = "";
    origin.pathname = "/";
    origin.search = "";
    return origin;
}

function connectionId(): string {
    return `mcn_${randomUUID().replaceAll("-", "")}`;
}

function installationId(): string {
    return `min_${randomUUID().replaceAll("-", "")}`;
}

function decodeInstallationPointer(value: unknown): InstallationPointer {
    if (!isRecord(value) || !hasExactKeys(value, INSTALLATION_POINTER_KEYS) || value["version"] !== 1) {
        throw new RuntimeInstallationStoreError("invalid_installation", "The local installation record is invalid");
    }
    const storedInstallationId = value["installationId"];
    if (typeof storedInstallationId !== "string") {
        throw new RuntimeInstallationStoreError("invalid_installation", "The local installation record is invalid");
    }
    return { installationId: validateInstallationId(storedInstallationId) };
}

function decodeChannelIndex(value: unknown): ChannelIndex {
    if (!isRecord(value) || !hasExactKeys(value, CHANNEL_INDEX_KEYS) || value["version"] !== 1) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    const applicationId = value["applicationId"];
    const channelId = value["channelId"];
    const connectionId = value["connectionId"];
    const storedInstallationId = value["installationId"];
    if (
        typeof applicationId !== "string" ||
        typeof channelId !== "string" ||
        typeof connectionId !== "string" ||
        typeof storedInstallationId !== "string"
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return {
        applicationId: validateApplicationId(applicationId),
        channelId: validateIdentifier(channelId, "invalid_connection"),
        connectionId: validateConnectionId(connectionId),
        installationId: validateInstallationId(storedInstallationId),
    };
}

function decodeVerifiedConnection(value: Readonly<Record<string, unknown>>): VerifiedRuntimeConnection {
    if (!hasExactKeys(value, VERIFIED_CONNECTION_KEYS) || value["version"] !== 5 || value["kind"] !== "verified") {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    const applicationId = value["applicationId"];
    const activation = value["activation"];
    const appId = value["appId"];
    const channelId = value["channelId"];
    const connectionId = value["connectionId"];
    const defaultWorkspace = value["defaultWorkspace"];
    const storedInstallationId = value["installationId"];
    const pairingId = value["pairingId"];
    const relayOrigin = value["relayOrigin"];
    const runtimeCredential = value["runtimeCredential"];
    const runtimeId = value["runtimeId"];
    if (
        typeof applicationId !== "string" ||
        (activation !== "active" && activation !== "stopped") ||
        typeof appId !== "string" ||
        typeof channelId !== "string" ||
        typeof connectionId !== "string" ||
        typeof defaultWorkspace !== "string" ||
        typeof storedInstallationId !== "string" ||
        typeof pairingId !== "string" ||
        typeof relayOrigin !== "string" ||
        typeof runtimeCredential !== "string" ||
        typeof runtimeId !== "string"
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return new VerifiedRuntimeConnection(
        activation,
        validateApplicationId(applicationId),
        validateRemoteAppId(appId),
        validateInstallationId(storedInstallationId),
        validateConnectionId(connectionId),
        validateIdentifier(channelId, "invalid_connection"),
        defaultWorkspace,
        pairingId.length === 0 ? "" : validateIdentifier(pairingId, "invalid_connection"),
        parseRelayOrigin(relayOrigin),
        validateRuntimeCredential(runtimeCredential),
        validateIdentifier(runtimeId, "invalid_connection"),
    );
}

function decodeConnection(value: unknown): VerifiedRuntimeConnection {
    if (!isRecord(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return decodeVerifiedConnection(value);
}

async function readJsonFile(path: string, signal: AbortSignal, missingCode: string): Promise<unknown> {
    signal.throwIfAborted();
    const read = await readInstallationFile(path);
    switch (read.kind) {
        case "missing":
            throw new RuntimeInstallationStoreError(missingCode, "The saved Runtime connection was not found", {
                cause: read.cause,
            });
        case "unopenable":
            throw new RuntimeInstallationStoreError(
                "connection_unavailable",
                "The saved Runtime connection cannot be read",
                {
                    cause: read.cause,
                },
            );
        case "not-a-small-file":
            throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
        case "read":
            break;
    }
    signal.throwIfAborted();
    try {
        return JSON.parse(read.text);
    } catch (cause) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid", {
            cause,
        });
    }
}

async function writeJsonAtomically(
    path: string,
    value: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
): Promise<void> {
    try {
        await writeInstallationFile(path, `${JSON.stringify(value, null, 2)}\n`, signal);
    } catch (cause) {
        signal.throwIfAborted();
        throw new RuntimeInstallationStoreError("connection_unavailable", "The local Runtime state cannot be written", {
            cause,
        });
    }
}

export class RuntimeInstallationStore {
    readonly applicationId: string;
    readonly installationId: string;
    readonly stateDirectory: InstallationDirectory;
    readonly #connectionDirectory: string;

    private constructor(applicationId: string, installationId: string, stateDirectory: InstallationDirectory) {
        this.applicationId = applicationId;
        this.installationId = installationId;
        this.stateDirectory = stateDirectory;
        this.#connectionDirectory = connectionDirectory(stateDirectory);
    }

    static readonly open = async (
        options: RuntimeInstallationStoreOptions,
        signal: AbortSignal,
    ): Promise<RuntimeInstallationStore> => {
        signal.throwIfAborted();
        const applicationId = validateApplicationId(options.applicationId);
        const dataDirectory = resolve(options.stateDirectory);
        try {
            await ensurePrivateDirectory(dataDirectory);
            await validateLocalPath(dataDirectory, true, true, signal);
        } catch (cause) {
            signal.throwIfAborted();
            throw new RuntimeInstallationStoreError(
                "installation_unavailable",
                "The local installation cannot be initialized",
                { cause },
            );
        }
        return await RuntimeInstallationStore.openEngine(
            applicationDirectoryPath(dataDirectory, applicationId),
            signal,
            applicationId,
        );
    };

    static readonly openEngine = async (
        engineDataDir: string,
        signal: AbortSignal,
        applicationId = "dev.mobius.cli",
    ): Promise<RuntimeInstallationStore> => {
        signal.throwIfAborted();
        const applicationDirectory = resolve(engineDataDir);
        try {
            await ensurePrivateDirectory(applicationDirectory);
            await validateLocalPath(applicationDirectory, true, true, signal);
        } catch (cause) {
            throw new RuntimeInstallationStoreError(
                "installation_unavailable",
                "The local installation cannot be initialized",
                {
                    cause,
                },
            );
        }
        const storedInstallationId = await readOrCreateInstallationId(applicationDirectory, signal);
        const stateDirectory = installationDirectory(applicationDirectory, storedInstallationId);
        try {
            await ensurePrivateDirectory(stateDirectory);
        } catch (cause) {
            throw new RuntimeInstallationStoreError(
                "installation_unavailable",
                "The local installation cannot be initialized",
                {
                    cause,
                },
            );
        }
        signal.throwIfAborted();
        return new RuntimeInstallationStore(applicationId, storedInstallationId, stateDirectory);
    };

    readonly connectionPath = (connectionId: string): string =>
        connectionFilePath(this.#connectionDirectory, validateConnectionId(connectionId));

    private readonly channelIndexPath = (channelId: string): string =>
        channelIndexFilePath(this.stateDirectory, validateIdentifier(channelId, "invalid_channel_id"));

    readonly readConnection = async (connectionId: string, signal: AbortSignal): Promise<VerifiedRuntimeConnection> => {
        const stored = decodeConnection(
            await readJsonFile(this.connectionPath(connectionId), signal, "connection_not_found"),
        );
        if (stored.applicationId !== this.applicationId || stored.installationId !== this.installationId) {
            throw new RuntimeInstallationStoreError(
                "connection_owner_mismatch",
                "The saved Runtime connection belongs to another installation",
            );
        }
        return stored;
    };

    readonly #readConnectionForChannel = async (
        channelId: string,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection> => {
        const normalizedChannelId = validateIdentifier(channelId, "invalid_channel_id");
        const index = decodeChannelIndex(
            await readJsonFile(this.channelIndexPath(normalizedChannelId), signal, "connection_not_found"),
        );
        if (
            index.applicationId !== this.applicationId ||
            index.installationId !== this.installationId ||
            index.channelId !== normalizedChannelId
        ) {
            throw new RuntimeInstallationStoreError(
                "connection_owner_mismatch",
                "The saved Runtime connection belongs to another installation",
            );
        }
        return await this.readConnection(index.connectionId, signal);
    };

    readonly saveConnection = async (
        input: RuntimeConnectionInput,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection> => {
        const stored = new VerifiedRuntimeConnection(
            "active",
            this.applicationId,
            validateRemoteAppId(input.appId),
            this.installationId,
            connectionId(),
            validateIdentifier(input.channelId, "invalid_connection"),
            input.defaultWorkspace,
            input.pairingId.length === 0 ? "" : validateIdentifier(input.pairingId, "invalid_pairing_id"),
            parseRelayOrigin(input.relayOrigin.toString()),
            validateRuntimeCredential(input.runtimeCredential),
            validateIdentifier(input.runtimeId, "invalid_connection"),
        );
        await this.writeConnection(stored, signal);
        return stored;
    };

    private readonly writeConnection = async (
        stored: VerifiedRuntimeConnection,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        try {
            await this.#readConnectionForChannel(stored.channelId, signal);
            throw new RuntimeInstallationStoreError(
                "connection_conflict",
                "A Runtime connection for this channel already exists in this installation",
            );
        } catch (cause) {
            if (!(cause instanceof RuntimeInstallationStoreError) || cause.code !== "connection_not_found") {
                throw cause;
            }
        }
        await this.overwriteConnection(stored, signal);
        await writeJsonAtomically(
            this.channelIndexPath(stored.channelId),
            {
                applicationId: this.applicationId,
                channelId: stored.channelId,
                connectionId: stored.connectionId,
                installationId: this.installationId,
                version: 1,
            },
            signal,
        );
    };

    readonly listConnections = async (signal: AbortSignal): Promise<readonly VerifiedRuntimeConnection[]> => {
        signal.throwIfAborted();
        let entries: readonly string[];
        try {
            entries = await listInstallationFiles(this.#connectionDirectory);
        } catch (cause) {
            if (isNodeError(cause, "ENOENT")) {
                return [];
            }
            throw new RuntimeInstallationStoreError(
                "connection_unavailable",
                "Saved Runtime connections cannot be listed",
                {
                    cause,
                },
            );
        }
        const connections: VerifiedRuntimeConnection[] = [];
        for (const entry of [...entries].sort()) {
            signal.throwIfAborted();
            const match = /^(mcn_[a-f0-9]{32})\.json$/.exec(entry);
            if (match?.[1] !== undefined) {
                connections.push(await this.readConnection(match[1], signal));
            }
        }
        return connections;
    };

    readonly readConnectionForPairing = async (
        pairingId: string,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection | null> => {
        const normalizedPairingId = validateIdentifier(pairingId, "invalid_pairing_id");
        const connections = await this.listConnections(signal);
        return connections.find((connection) => connection.pairingId === normalizedPairingId) ?? null;
    };

    readonly setConnectionActivation = async (
        connectionId: string,
        activation: RuntimeConnectionActivation,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection> => {
        const connection = await this.readConnection(connectionId, signal);
        const updated = new VerifiedRuntimeConnection(
            activation,
            connection.applicationId,
            connection.appId,
            connection.installationId,
            connection.connectionId,
            connection.channelId,
            connection.defaultWorkspace,
            connection.pairingId,
            connection.relayOrigin,
            connection.runtimeCredential,
            connection.runtimeId,
        );
        await this.overwriteConnection(updated, signal);
        return updated;
    };

    readonly removeConnection = async (connectionId: string, signal: AbortSignal): Promise<void> => {
        const connection = await this.readConnection(connectionId, signal);
        signal.throwIfAborted();
        try {
            await removeInstallationFile(this.connectionPath(connection.connectionId));
            signal.throwIfAborted();
            await removeInstallationFile(this.channelIndexPath(connection.channelId));
        } catch (cause) {
            signal.throwIfAborted();
            if (isNodeError(cause, "ENOENT")) {
                return;
            }
            throw new RuntimeInstallationStoreError(
                "connection_unavailable",
                "The saved Runtime connection cannot be removed",
                { cause },
            );
        }
    };

    private readonly overwriteConnection = async (
        connection: VerifiedRuntimeConnection,
        signal: AbortSignal,
    ): Promise<void> => {
        const connectionPath = this.connectionPath(connection.connectionId);
        await writeJsonAtomically(
            connectionPath,
            {
                activation: connection.activation,
                applicationId: connection.applicationId,
                appId: connection.appId,
                channelId: connection.channelId,
                connectionId: connection.connectionId,
                defaultWorkspace: connection.defaultWorkspace,
                installationId: connection.installationId,
                kind: connection.kind,
                pairingId: connection.pairingId,
                relayOrigin: connection.relayOrigin.toString(),
                runtimeCredential: connection.runtimeCredential,
                runtimeId: connection.runtimeId,
                version: 5,
            },
            signal,
        );
    };
}

async function readOrCreateInstallationId(applicationDirectory: string, signal: AbortSignal): Promise<string> {
    const pointerPath = installationPointerPath(applicationDirectory);
    try {
        return decodeInstallationPointer(await readJsonFile(pointerPath, signal, "installation_not_found"))
            .installationId;
    } catch (cause) {
        if (!(cause instanceof RuntimeInstallationStoreError) || cause.code !== "installation_not_found") {
            throw cause;
        }
    }

    const candidate = installationId();
    try {
        await createInstallationFile(pointerPath, `${JSON.stringify({ installationId: candidate, version: 1 })}\n`);
        return candidate;
    } catch (cause) {
        if (!isNodeError(cause, "EEXIST")) {
            throw new RuntimeInstallationStoreError(
                "installation_unavailable",
                "The local installation cannot be initialized",
                {
                    cause,
                },
            );
        }
        return decodeInstallationPointer(await readJsonFile(pointerPath, signal, "installation_not_found"))
            .installationId;
    }
}

export async function openRuntimeInstallationStore(
    options: RuntimeInstallationStoreOptions,
    signal: AbortSignal,
): Promise<RuntimeInstallationStore> {
    return await RuntimeInstallationStore.open(options, signal);
}

export async function openEngineInstallationStore(
    engineDataDir: string,
    signal: AbortSignal,
): Promise<RuntimeInstallationStore> {
    return await RuntimeInstallationStore.openEngine(engineDataDir, signal);
}
