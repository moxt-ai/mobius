import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const APPLICATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){1,31}$/;
const CONNECTION_ID_PATTERN = /^mcn_[a-f0-9]{32}$/;
const INSTALLATION_ID_PATTERN = /^min_[a-f0-9]{32}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const RUNTIME_CREDENTIAL_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const MAX_FILE_LENGTH = 16 * 1024;
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
const VERSION_THREE_VERIFIED_CONNECTION_KEYS: readonly string[] = VERIFIED_CONNECTION_KEYS.filter(
    (key) => key !== "activation",
);
const VERSION_FOUR_VERIFIED_CONNECTION_KEYS: readonly string[] = VERIFIED_CONNECTION_KEYS;
const VERSION_TWO_VERIFIED_CONNECTION_KEYS: readonly string[] = VERSION_THREE_VERIFIED_CONNECTION_KEYS.filter(
    (key) => key !== "pairingId",
);
const LEGACY_VERIFIED_CONNECTION_KEYS: readonly string[] = VERSION_TWO_VERIFIED_CONNECTION_KEYS.filter(
    (key) => key !== "appId",
);
const IMPORTED_LEGACY_CONNECTION_KEYS: readonly string[] = [
    "activation",
    "applicationId",
    "channelId",
    "connectionId",
    "defaultWorkspace",
    "installationId",
    "kind",
    "relayOrigin",
    "runtimeCredential",
    "version",
];
const VERSION_ONE_IMPORTED_LEGACY_CONNECTION_KEYS: readonly string[] = IMPORTED_LEGACY_CONNECTION_KEYS.filter(
    (key) => key !== "activation",
);

export interface RuntimeInstallationStoreOptions {
    readonly applicationId: string;
    readonly stateDirectory: string;
}

export interface RuntimeConnectionInput {
    readonly appId: string;
    readonly channelId: string;
    readonly defaultWorkspace: string;
    readonly pairingId: string;
    readonly relayOrigin: URL;
    readonly runtimeCredential: string;
    readonly runtimeId: string;
}

export type RuntimeConnectionActivation = "active" | "stopped";

export class RuntimeInstallationStoreError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "RuntimeInstallationStoreError";
    }
}

export abstract class StoredRuntimeConnection {
    readonly activation: RuntimeConnectionActivation;
    readonly appId: string;
    readonly applicationId: string;
    readonly channelId: string;
    readonly connectionId: string;
    readonly defaultWorkspace: string;
    readonly installationId: string;
    readonly pairingId: string;
    readonly relayOrigin: URL;
    readonly runtimeCredential: string;

    protected constructor(
        activation: RuntimeConnectionActivation,
        applicationId: string,
        appId: string,
        installationId: string,
        connectionId: string,
        channelId: string,
        defaultWorkspace: string,
        pairingId: string,
        relayOrigin: URL,
        runtimeCredential: string,
    ) {
        this.activation = activation;
        this.applicationId = applicationId;
        this.appId = appId;
        this.channelId = channelId;
        this.connectionId = connectionId;
        this.defaultWorkspace = defaultWorkspace;
        this.installationId = installationId;
        this.pairingId = pairingId;
        this.relayOrigin = relayOrigin;
        this.runtimeCredential = runtimeCredential;
    }

    abstract readonly kind: string;
}

export class VerifiedRuntimeConnection extends StoredRuntimeConnection {
    readonly kind = "verified";
    readonly runtimeId: string;

    constructor(
        activation: RuntimeConnectionActivation,
        applicationId: string,
        appId: string,
        installationId: string,
        connectionId: string,
        channelId: string,
        defaultWorkspace: string,
        pairingId: string,
        relayOrigin: URL,
        runtimeCredential: string,
        runtimeId: string,
    ) {
        super(
            activation,
            applicationId,
            appId,
            installationId,
            connectionId,
            channelId,
            defaultWorkspace,
            pairingId,
            relayOrigin,
            runtimeCredential,
        );
        this.runtimeId = runtimeId;
    }
}

export class ImportedLegacyRuntimeConnection extends StoredRuntimeConnection {
    readonly kind = "legacy_imported";

    constructor(
        activation: RuntimeConnectionActivation,
        applicationId: string,
        installationId: string,
        connectionId: string,
        channelId: string,
        defaultWorkspace: string,
        relayOrigin: URL,
        runtimeCredential: string,
    ) {
        super(
            activation,
            applicationId,
            "unknown",
            installationId,
            connectionId,
            channelId,
            defaultWorkspace,
            "",
            relayOrigin,
            runtimeCredential,
        );
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

function isNodeError(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function validateApplicationId(value: string): string {
    if (!APPLICATION_ID_PATTERN.test(value)) {
        throw new RuntimeInstallationStoreError("invalid_application_id", "The application ID is invalid");
    }
    return value;
}

function validateRemoteAppId(value: string): string {
    if (!IDENTIFIER_PATTERN.test(value)) {
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
    if (!IDENTIFIER_PATTERN.test(value)) {
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

function channelIndexFileName(channelId: string): string {
    return `mci_${createHash("sha256").update(channelId).digest("hex")}.json`;
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
    const current = hasExactKeys(value, VERIFIED_CONNECTION_KEYS) && value["version"] === 5;
    const versionFour = hasExactKeys(value, VERSION_FOUR_VERIFIED_CONNECTION_KEYS) && value["version"] === 4;
    const versionThree = hasExactKeys(value, VERSION_THREE_VERIFIED_CONNECTION_KEYS) && value["version"] === 3;
    const versionTwo = hasExactKeys(value, VERSION_TWO_VERIFIED_CONNECTION_KEYS) && value["version"] === 2;
    const legacy = hasExactKeys(value, LEGACY_VERIFIED_CONNECTION_KEYS) && value["version"] === 1;
    if ((!current && !versionFour && !versionThree && !versionTwo && !legacy) || value["kind"] !== "verified") {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    const applicationId = value["applicationId"];
    const activation = current || versionFour ? value["activation"] : "active";
    const appId = current && typeof value["appId"] === "string" ? value["appId"] : "unknown";
    const channelId = value["channelId"];
    const connectionId = value["connectionId"];
    const defaultWorkspace = value["defaultWorkspace"];
    const storedInstallationId = value["installationId"];
    const pairingId = value["pairingId"];
    const savedPairingId = typeof pairingId === "string" ? pairingId : "";
    const relayOrigin = value["relayOrigin"];
    const runtimeCredential = value["runtimeCredential"];
    const runtimeId = value["runtimeId"];
    if (
        typeof applicationId !== "string" ||
        (activation !== "active" && activation !== "stopped") ||
        ((current || versionFour || versionThree || versionTwo) && typeof value["appId"] !== "string") ||
        typeof channelId !== "string" ||
        typeof connectionId !== "string" ||
        typeof defaultWorkspace !== "string" ||
        typeof storedInstallationId !== "string" ||
        ((current || versionFour || versionThree) && typeof pairingId !== "string") ||
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
        (current || versionFour || versionThree) && savedPairingId.length > 0
            ? validateIdentifier(savedPairingId, "invalid_connection")
            : "",
        parseRelayOrigin(relayOrigin),
        validateRuntimeCredential(runtimeCredential),
        validateIdentifier(runtimeId, "invalid_connection"),
    );
}

function decodeImportedLegacyConnection(value: Readonly<Record<string, unknown>>): ImportedLegacyRuntimeConnection {
    const current = hasExactKeys(value, IMPORTED_LEGACY_CONNECTION_KEYS) && value["version"] === 2;
    const legacy = hasExactKeys(value, VERSION_ONE_IMPORTED_LEGACY_CONNECTION_KEYS) && value["version"] === 1;
    if (
        (!current && !legacy) ||
        value["kind"] !== "legacy_imported" ||
        (value["version"] !== 1 && value["version"] !== 2)
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    const applicationId = value["applicationId"];
    const activation = current ? value["activation"] : "active";
    const channelId = value["channelId"];
    const connectionId = value["connectionId"];
    const defaultWorkspace = value["defaultWorkspace"];
    const storedInstallationId = value["installationId"];
    const relayOrigin = value["relayOrigin"];
    const runtimeCredential = value["runtimeCredential"];
    if (
        typeof applicationId !== "string" ||
        (activation !== "active" && activation !== "stopped") ||
        typeof channelId !== "string" ||
        typeof connectionId !== "string" ||
        typeof defaultWorkspace !== "string" ||
        typeof storedInstallationId !== "string" ||
        typeof relayOrigin !== "string" ||
        typeof runtimeCredential !== "string"
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return new ImportedLegacyRuntimeConnection(
        activation,
        validateApplicationId(applicationId),
        validateInstallationId(storedInstallationId),
        validateConnectionId(connectionId),
        validateIdentifier(channelId, "invalid_connection"),
        defaultWorkspace,
        parseRelayOrigin(relayOrigin),
        validateRuntimeCredential(runtimeCredential),
    );
}

function decodeConnection(value: unknown): StoredRuntimeConnection {
    if (!isRecord(value)) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    if (value["kind"] === "verified") {
        return decodeVerifiedConnection(value);
    }
    if (value["kind"] === "legacy_imported") {
        return decodeImportedLegacyConnection(value);
    }
    throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
}

async function readJsonFile(path: string, signal: AbortSignal, missingCode: string): Promise<unknown> {
    signal.throwIfAborted();
    let handle: FileHandle;
    try {
        handle = await open(path, "r");
    } catch (cause) {
        if (isNodeError(cause, "ENOENT")) {
            throw new RuntimeInstallationStoreError(missingCode, "The saved Runtime connection was not found", {
                cause,
            });
        }
        throw new RuntimeInstallationStoreError(
            "connection_unavailable",
            "The saved Runtime connection cannot be read",
            {
                cause,
            },
        );
    }
    let encoded = "";
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAX_FILE_LENGTH) {
            throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
        }
        encoded = await handle.readFile({ encoding: "utf8" });
    } finally {
        await handle.close();
    }
    signal.throwIfAborted();
    try {
        return JSON.parse(encoded);
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
    signal.throwIfAborted();
    const directory = dirname(path);
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
    try {
        await mkdir(directory, { mode: 0o700, recursive: true });
        signal.throwIfAborted();
        await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        signal.throwIfAborted();
        await rename(temporaryPath, path);
    } catch (cause) {
        await unlink(temporaryPath).catch(() => undefined);
        signal.throwIfAborted();
        throw new RuntimeInstallationStoreError("connection_unavailable", "The local Runtime state cannot be written", {
            cause,
        });
    }
}

export class RuntimeInstallationStore {
    readonly applicationId: string;
    readonly installationId: string;
    readonly stateDirectory: string;
    readonly #channelDirectory: string;
    readonly #connectionDirectory: string;

    private constructor(applicationId: string, installationId: string, stateDirectory: string) {
        this.applicationId = applicationId;
        this.installationId = installationId;
        this.stateDirectory = stateDirectory;
        this.#channelDirectory = join(stateDirectory, "channels");
        this.#connectionDirectory = join(stateDirectory, "connections");
    }

    static readonly open = async (
        options: RuntimeInstallationStoreOptions,
        signal: AbortSignal,
    ): Promise<RuntimeInstallationStore> => {
        signal.throwIfAborted();
        const applicationId = validateApplicationId(options.applicationId);
        const rootDirectory = resolve(options.stateDirectory);
        const applicationDirectory = join(rootDirectory, "installations", applicationId);
        try {
            await mkdir(applicationDirectory, { mode: 0o700, recursive: true });
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
        const stateDirectory = join(applicationDirectory, storedInstallationId);
        try {
            await mkdir(stateDirectory, { mode: 0o700, recursive: true });
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
        join(this.#connectionDirectory, `${validateConnectionId(connectionId)}.json`);

    private readonly channelIndexPath = (channelId: string): string =>
        join(this.#channelDirectory, channelIndexFileName(validateIdentifier(channelId, "invalid_channel_id")));

    readonly readConnection = async (connectionId: string, signal: AbortSignal): Promise<StoredRuntimeConnection> => {
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
    ): Promise<StoredRuntimeConnection> => {
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

    private readonly writeConnection = async (stored: StoredRuntimeConnection, signal: AbortSignal): Promise<void> => {
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

    readonly listConnections = async (signal: AbortSignal): Promise<readonly StoredRuntimeConnection[]> => {
        signal.throwIfAborted();
        let entries: readonly string[];
        try {
            entries = await readdir(this.#connectionDirectory);
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
        const connections: StoredRuntimeConnection[] = [];
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
    ): Promise<StoredRuntimeConnection | null> => {
        const normalizedPairingId = validateIdentifier(pairingId, "invalid_pairing_id");
        const connections = await this.listConnections(signal);
        return connections.find((connection) => connection.pairingId === normalizedPairingId) ?? null;
    };

    readonly setConnectionActivation = async (
        connectionId: string,
        activation: RuntimeConnectionActivation,
        signal: AbortSignal,
    ): Promise<StoredRuntimeConnection> => {
        const connection = await this.readConnection(connectionId, signal);
        const updated =
            connection instanceof VerifiedRuntimeConnection
                ? new VerifiedRuntimeConnection(
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
                  )
                : new ImportedLegacyRuntimeConnection(
                      activation,
                      connection.applicationId,
                      connection.installationId,
                      connection.connectionId,
                      connection.channelId,
                      connection.defaultWorkspace,
                      connection.relayOrigin,
                      connection.runtimeCredential,
                  );
        await this.overwriteConnection(updated, signal);
        return updated;
    };

    readonly removeConnection = async (connectionId: string, signal: AbortSignal): Promise<void> => {
        const connection = await this.readConnection(connectionId, signal);
        signal.throwIfAborted();
        try {
            await unlink(this.connectionPath(connection.connectionId));
            signal.throwIfAborted();
            await unlink(this.channelIndexPath(connection.channelId));
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
        connection: StoredRuntimeConnection,
        signal: AbortSignal,
    ): Promise<void> => {
        const connectionPath = this.connectionPath(connection.connectionId);
        if (connection instanceof VerifiedRuntimeConnection) {
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
            return;
        }
        await writeJsonAtomically(
            connectionPath,
            {
                activation: connection.activation,
                applicationId: connection.applicationId,
                channelId: connection.channelId,
                connectionId: connection.connectionId,
                defaultWorkspace: connection.defaultWorkspace,
                installationId: connection.installationId,
                kind: connection.kind,
                relayOrigin: connection.relayOrigin.toString(),
                runtimeCredential: connection.runtimeCredential,
                version: 2,
            },
            signal,
        );
    };
}

async function readOrCreateInstallationId(applicationDirectory: string, signal: AbortSignal): Promise<string> {
    const pointerPath = join(applicationDirectory, "current.json");
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
        await writeFile(pointerPath, `${JSON.stringify({ installationId: candidate, version: 1 })}\n`, {
            flag: "wx",
            mode: 0o600,
        });
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
