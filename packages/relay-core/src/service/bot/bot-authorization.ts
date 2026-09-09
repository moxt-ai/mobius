import {
    BotConnectorAccess,
    BotOwnerAccess,
    BotRuntimeExecutionAccess,
    InboundBotConnectorPrincipal,
    InboundBotOwnerPrincipal,
    type InboundBotPrincipal,
    ProjectOwnerAccess,
} from "../../entity/bot/bot-access.ts";
import { BotApiError } from "../../entity/bot/bot-error.ts";
import { ProjectScope } from "../../entity/do/session.ts";
import { hashSecret, validateIdentifier, validateToken } from "../../entity/pairing/pairing.ts";
import type { BotCredentialStorage } from "../../storage/bot-credential-storage.ts";

function decodeScopes(encoded: string): readonly string[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", "The connection authorization is invalid", "unavailable", {
            cause,
        });
    }
    if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string")) {
        throw new BotApiError("bot_service_unavailable", "The connection authorization is invalid", "unavailable");
    }
    return value.filter((scope) => typeof scope === "string");
}

export class BotAuthorization {
    readonly #credentials: readonly BotCredentialStorage[];

    constructor(credentials: readonly BotCredentialStorage[]) {
        this.#credentials = credentials;
    }

    private readonly findCredential = async <Value>(
        read: (storage: BotCredentialStorage) => Promise<Value | null>,
        signal: AbortSignal,
    ) => {
        let match: { readonly record: Value; readonly storage: BotCredentialStorage } | null = null;
        for (const storage of this.#credentials) {
            signal.throwIfAborted();
            const record = await read(storage);
            signal.throwIfAborted();
            if (record === null) {
                continue;
            }
            if (match !== null) {
                throw new BotApiError("credential_invalid", "The Bot credential is ambiguous", "unauthenticated");
            }
            match = { record, storage };
        }
        return match;
    };

    readonly authenticateGrant = async (
        grantId: string,
        digest: string,
        audience: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const match = await this.findCredential(
            (storage) => storage.readGrant(grantId, digest, audience, now, signal),
            signal,
        );
        if (match === null) {
            throw new BotApiError(
                "credential_invalid",
                "The Bot connection grant is invalid or consumed",
                "unauthenticated",
            );
        }
        return match.record;
    };

    readonly authorizeProjectOwner = async (
        projectId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<ProjectOwnerAccess> => {
        signal.throwIfAborted();
        const normalizedProjectId = validateIdentifier(projectId, "project_id");
        const tokenDigest = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const match = await this.findCredential(
            (storage) => storage.readProjectOwner(normalizedProjectId, tokenDigest, signal),
            signal,
        );
        const row = match?.record ?? null;
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError("owner_access_required", "An owner credential is required", "access-denied");
        }
        return new ProjectOwnerAccess(new ProjectScope(row.tenant_id, row.project_id), row.credential_id);
    };

    readonly authorizeBotOwner = async (botId: string, token: string, signal: AbortSignal): Promise<BotOwnerAccess> => {
        signal.throwIfAborted();
        const normalizedBotId = validateIdentifier(botId, "bot_id");
        const tokenDigest = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const match = await this.findCredential(
            (storage) => storage.readBotOwner(normalizedBotId, tokenDigest, signal),
            signal,
        );
        const row = match?.record ?? null;
        signal.throwIfAborted();
        if (row === null) {
            const exists = (
                await Promise.all(this.#credentials.map((storage) => storage.botExists(normalizedBotId, signal)))
            ).some(Boolean);
            signal.throwIfAborted();
            if (!exists) {
                throw new BotApiError("bot_not_found", "The Bot does not exist", "not-found");
            }
            throw new BotApiError("owner_access_required", "An owner credential is required", "access-denied");
        }
        return new BotOwnerAccess(new ProjectScope(row.tenant_id, row.project_id), row.credential_id, row.bot_id);
    };

    readonly authorizeConnector = async (
        connectionId: string,
        token: string,
        requiredScope: string,
        signal: AbortSignal,
    ): Promise<BotConnectorAccess> => {
        const access = await this.authorizeConnectorCredential(connectionId, token, signal);
        if (!access.scopes.includes(requiredScope)) {
            throw new BotApiError("scope_denied", "The Bot connection scope is not granted", "access-denied");
        }
        return access;
    };

    readonly authorizeConnectorManagement = async (
        connectionId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<BotConnectorAccess> => await this.authorizeConnectorCredential(connectionId, token, signal);

    private readonly authorizeConnectorCredential = async (
        connectionId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<BotConnectorAccess> => {
        signal.throwIfAborted();
        const normalizedConnectionId = validateIdentifier(connectionId, "connection_id");
        const tokenDigest = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const now = Date.now();
        const match = await this.findCredential(
            (storage) => storage.readConnector(normalizedConnectionId, tokenDigest, now, signal),
            signal,
        );
        signal.throwIfAborted();
        if (match === null) {
            const lifecycles = await Promise.all(
                this.#credentials.map((storage) => storage.readConnectionLifecycle(normalizedConnectionId, signal)),
            );
            signal.throwIfAborted();
            if (lifecycles.includes("revoked")) {
                throw new BotApiError("connection_revoked", "The Bot connection was revoked", "unauthenticated");
            }
            throw new BotApiError("credential_invalid", "The Bot connection credential is invalid", "unauthenticated");
        }
        const row = match.record;
        const scopes = decodeScopes(row.scopes_json);
        const touched = await match.storage.recordConnectionUse(row.credential_id, row.connection_id, now, signal);
        signal.throwIfAborted();
        if (!touched) {
            throw new BotApiError("credential_invalid", "The Bot connection credential is invalid", "unauthenticated");
        }
        return new BotConnectorAccess(
            new ProjectScope(row.tenant_id, row.project_id),
            row.bot_id,
            row.connection_id,
            row.credential_id,
            row.connector_principal_id,
            row.audience,
            scopes,
        );
    };

    readonly authorizeInbound = async (
        botId: string,
        token: string,
        requiredConnectorScope: string,
        signal: AbortSignal,
    ): Promise<InboundBotPrincipal> => {
        try {
            return new InboundBotOwnerPrincipal(await this.authorizeBotOwner(botId, token, signal));
        } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof BotApiError) || error.code === "bot_not_found") {
                throw error;
            }
        }
        const tokenDigest = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const match = await this.findCredential(
            (storage) => storage.findInboundConnection(validateIdentifier(botId, "bot_id"), tokenDigest, signal),
            signal,
        );
        const connectionId = match?.record ?? null;
        signal.throwIfAborted();
        if (connectionId === null) {
            throw new BotApiError(
                "conversation_access_denied",
                "The Bot conversation is not accessible",
                "access-denied",
            );
        }
        return new InboundBotConnectorPrincipal(
            await this.authorizeConnector(connectionId, token, requiredConnectorScope, signal),
        );
    };

    readonly authorizeRuntimeExecution = async (
        executionId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<BotRuntimeExecutionAccess> => {
        signal.throwIfAborted();
        const tokenDigest = await hashSecret(validateToken(token));
        const match = await this.findCredential(
            (storage) =>
                storage.readRuntimeExecution(validateIdentifier(executionId, "execution_id"), tokenDigest, signal),
            signal,
        );
        const row = match?.record ?? null;
        signal.throwIfAborted();
        if (row === null) {
            throw new BotApiError(
                "execution_context_required",
                "An authenticated Bot execution context is required",
                "unauthenticated",
            );
        }
        if (row.bot_lifecycle === "suspended") {
            throw new BotApiError("bot_suspended", "The Bot is suspended", "conflict");
        }
        if (row.bot_lifecycle !== "active") {
            throw new BotApiError("bot_not_active", "The Bot is not active", "conflict");
        }
        return new BotRuntimeExecutionAccess(row);
    };
}
