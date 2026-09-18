import { createHash, randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
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
    "applicationId",
    "channelId",
    "connectionId",
    "defaultWorkspace",
    "installationId",
    "kind",
    "relayOrigin",
    "runtimeCredential",
    "runtimeId",
    "version",
];
const IMPORTED_LEGACY_CONNECTION_KEYS: readonly string[] = [
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
const CURRENT_CONNECTION_KEYS: readonly string[] = [
    "defaultWorkspace",
    "channelId",
    "relayOrigin",
    "runtimeCredential",
];
const LEGACY_CONNECTION_KEYS: readonly string[] = ["defaultWorkspace", "channelId", "daemonToken", "relayOrigin"];

export interface RuntimeInstallationStoreOptions {
    readonly applicationId: string;
    readonly stateDirectory: string;
}

export interface RuntimeConnectionInput {
    readonly channelId: string;
    readonly defaultWorkspace: string;
    readonly relayOrigin: URL;
    readonly runtimeCredential: string;
    readonly runtimeId: string;
}

export class RuntimeInstallationStoreError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "RuntimeInstallationStoreError";
    }
}

export abstract class StoredRuntimeConnection {
    readonly applicationId: string;
    readonly channelId: string;
    readonly connectionId: string;
    readonly defaultWorkspace: string;
    readonly installationId: string;
    readonly relayOrigin: URL;
    readonly runtimeCredential: string;

    protected constructor(
        applicationId: string,
        installationId: string,
        connectionId: string,
        channelId: string,
        defaultWorkspace: string,
        relayOrigin: URL,
        runtimeCredential: string,
    ) {
        this.applicationId = applicationId;
        this.channelId = channelId;
        this.connectionId = connectionId;
        this.defaultWorkspace = defaultWorkspace;
        this.installationId = installationId;
        this.relayOrigin = relayOrigin;
        this.runtimeCredential = runtimeCredential;
    }

    abstract readonly kind: string;
}

export class VerifiedRuntimeConnection extends StoredRuntimeConnection {
    readonly kind = "verified";
    readonly runtimeId: string;

    constructor(
        applicationId: string,
        installationId: string,
        connectionId: string,
        channelId: string,
        defaultWorkspace: string,
        relayOrigin: URL,
        runtimeCredential: string,
        runtimeId: string,
    ) {
        super(applicationId, installationId, connectionId, channelId, defaultWorkspace, relayOrigin, runtimeCredential);
        this.runtimeId = runtimeId;
    }
}

export class ImportedLegacyRuntimeConnection extends StoredRuntimeConnection {
    readonly kind = "legacy_imported";

    constructor(
        applicationId: string,
        installationId: string,
        connectionId: string,
        channelId: string,
        defaultWorkspace: string,
        relayOrigin: URL,
        runtimeCredential: string,
    ) {
        super(applicationId, installationId, connectionId, channelId, defaultWorkspace, relayOrigin, runtimeCredential);
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

interface LegacyConnectionInput {
    readonly channelId: string;
    readonly defaultWorkspace: string;
    readonly relayOrigin: URL;
    readonly runtimeCredential: string;
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
    if (!hasExactKeys(value, VERIFIED_CONNECTION_KEYS) || value["kind"] !== "verified" || value["version"] !== 1) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    const applicationId = value["applicationId"];
    const channelId = value["channelId"];
    const connectionId = value["connectionId"];
    const defaultWorkspace = value["defaultWorkspace"];
    const storedInstallationId = value["installationId"];
    const relayOrigin = value["relayOrigin"];
    const runtimeCredential = value["runtimeCredential"];
    const runtimeId = value["runtimeId"];
    if (
        typeof applicationId !== "string" ||
        typeof channelId !== "string" ||
        typeof connectionId !== "string" ||
        typeof defaultWorkspace !== "string" ||
        typeof storedInstallationId !== "string" ||
        typeof relayOrigin !== "string" ||
        typeof runtimeCredential !== "string" ||
        typeof runtimeId !== "string"
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return new VerifiedRuntimeConnection(
        validateApplicationId(applicationId),
        validateInstallationId(storedInstallationId),
        validateConnectionId(connectionId),
        validateIdentifier(channelId, "invalid_connection"),
        defaultWorkspace,
        parseRelayOrigin(relayOrigin),
        validateRuntimeCredential(runtimeCredential),
        validateIdentifier(runtimeId, "invalid_connection"),
    );
}

function decodeImportedLegacyConnection(value: Readonly<Record<string, unknown>>): ImportedLegacyRuntimeConnection {
    if (
        !hasExactKeys(value, IMPORTED_LEGACY_CONNECTION_KEYS) ||
        value["kind"] !== "legacy_imported" ||
        value["version"] !== 1
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    const applicationId = value["applicationId"];
    const channelId = value["channelId"];
    const connectionId = value["connectionId"];
    const defaultWorkspace = value["defaultWorkspace"];
    const storedInstallationId = value["installationId"];
    const relayOrigin = value["relayOrigin"];
    const runtimeCredential = value["runtimeCredential"];
    if (
        typeof applicationId !== "string" ||
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

function decodeLegacyConnection(value: unknown, expectedChannelId: string): LegacyConnectionInput {
    if (
        !isRecord(value) ||
        (!hasExactKeys(value, CURRENT_CONNECTION_KEYS) && !hasExactKeys(value, LEGACY_CONNECTION_KEYS))
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    const channelId = value["channelId"];
    const defaultWorkspace = value["defaultWorkspace"];
    const relayOrigin = value["relayOrigin"];
    const runtimeCredential = value["runtimeCredential"] ?? value["daemonToken"];
    if (
        typeof channelId !== "string" ||
        channelId !== expectedChannelId ||
        typeof defaultWorkspace !== "string" ||
        typeof relayOrigin !== "string" ||
        typeof runtimeCredential !== "string"
    ) {
        throw new RuntimeInstallationStoreError("invalid_connection", "The saved Runtime connection is invalid");
    }
    return {
        channelId: validateIdentifier(channelId, "invalid_connection"),
        defaultWorkspace,
        relayOrigin: parseRelayOrigin(relayOrigin),
        runtimeCredential: validateRuntimeCredential(runtimeCredential),
    };
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

    readonly auditDatabasePath = (connectionId: string): string =>
        join(this.stateDirectory, "audit", `${validateConnectionId(connectionId)}.sqlite`);

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

    readonly migrateLegacyConnection = async (
        legacyStateDirectory: string,
        channelId: string,
        signal: AbortSignal,
    ): Promise<StoredRuntimeConnection> => {
        try {
            return await this.#readConnectionForChannel(channelId, signal);
        } catch (cause) {
            if (!(cause instanceof RuntimeInstallationStoreError) || cause.code !== "connection_not_found") {
                throw cause;
            }
        }
        return await this.importLegacyConnection(legacyStateDirectory, channelId, signal);
    };

    readonly saveConnection = async (
        input: RuntimeConnectionInput,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection> => {
        const stored = new VerifiedRuntimeConnection(
            this.applicationId,
            this.installationId,
            connectionId(),
            validateIdentifier(input.channelId, "invalid_connection"),
            input.defaultWorkspace,
            parseRelayOrigin(input.relayOrigin.toString()),
            validateRuntimeCredential(input.runtimeCredential),
            validateIdentifier(input.runtimeId, "invalid_connection"),
        );
        await this.writeConnection(stored, signal);
        return stored;
    };

    readonly importLegacyConnection = async (
        legacyStateDirectory: string,
        channelId: string,
        signal: AbortSignal,
    ): Promise<ImportedLegacyRuntimeConnection> => {
        const normalizedChannelId = validateIdentifier(channelId, "invalid_channel_id");
        const legacyPath = join(resolve(legacyStateDirectory), "connections", `${normalizedChannelId}.json`);
        const legacy = decodeLegacyConnection(
            await readJsonFile(legacyPath, signal, "connection_not_found"),
            normalizedChannelId,
        );
        const stored = new ImportedLegacyRuntimeConnection(
            this.applicationId,
            this.installationId,
            connectionId(),
            legacy.channelId,
            legacy.defaultWorkspace,
            legacy.relayOrigin,
            legacy.runtimeCredential,
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
        const connectionPath = this.connectionPath(stored.connectionId);
        if (stored instanceof VerifiedRuntimeConnection) {
            await writeJsonAtomically(
                connectionPath,
                {
                    applicationId: stored.applicationId,
                    channelId: stored.channelId,
                    connectionId: stored.connectionId,
                    defaultWorkspace: stored.defaultWorkspace,
                    installationId: stored.installationId,
                    kind: stored.kind,
                    relayOrigin: stored.relayOrigin.toString(),
                    runtimeCredential: stored.runtimeCredential,
                    runtimeId: stored.runtimeId,
                    version: 1,
                },
                signal,
            );
        } else {
            await writeJsonAtomically(
                connectionPath,
                {
                    applicationId: stored.applicationId,
                    channelId: stored.channelId,
                    connectionId: stored.connectionId,
                    defaultWorkspace: stored.defaultWorkspace,
                    installationId: stored.installationId,
                    kind: stored.kind,
                    relayOrigin: stored.relayOrigin.toString(),
                    runtimeCredential: stored.runtimeCredential,
                    version: 1,
                },
                signal,
            );
        }
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
