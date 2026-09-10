import {
    decodeProjectCredential,
    type ProjectAccessAuthorizer,
    type ProjectAccessContext,
    ProjectCredentialScheme,
    type ProjectPermission,
} from "../../entity/authentication/project-authentication.ts";
import {
    BotConnectionAccess,
    type BotConversationAuthorization,
    BotRuntimeExecutionAccess,
    ProjectBotAccess,
    ProjectConversationAccess,
} from "../../entity/bot/bot-access.ts";
import { BotApiError } from "../../entity/bot/bot-error.ts";
import { ProjectScope } from "../../entity/do/session.ts";
import { hashSecret, validateIdentifier, validateToken } from "../../entity/pairing/pairing.ts";
import {
    type BotConversationScopeLookup,
    type BotProjectScopeLookup,
    FoundBotConversationScope,
    FoundBotProjectScope,
    type InboundCredentialPlaneRecord,
    MissingBotConversationScope,
    MissingBotProjectScope,
} from "../../storage/bot-credential-records.ts";
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
    readonly #projectAuthentication: ProjectAccessAuthorizer;

    constructor(credentials: readonly BotCredentialStorage[], projectAuthentication: ProjectAccessAuthorizer) {
        this.#credentials = credentials;
        this.#projectAuthentication = projectAuthentication;
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

    readonly authorizeProject = async (
        projectId: string,
        token: string,
        permission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<ProjectAccessContext> =>
        await this.#projectAuthentication.authorizeProject(projectId, token, permission, actorReference, signal);

    readonly authorizeProjectBot = async (
        botId: string,
        token: string,
        permission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<ProjectBotAccess> => {
        const normalizedBotId = validateIdentifier(botId, "bot_id");
        decodeProjectCredential(token);
        let scope: BotProjectScopeLookup = new MissingBotProjectScope();
        for (const storage of this.#credentials) {
            signal.throwIfAborted();
            const candidate = await storage.readBotProjectScope(normalizedBotId, signal);
            signal.throwIfAborted();
            if (candidate instanceof MissingBotProjectScope) {
                continue;
            }
            if (!(candidate instanceof FoundBotProjectScope)) {
                throw new BotApiError("bot_service_unavailable", "The Bot Project scope is invalid", "unavailable");
            }
            if (scope instanceof FoundBotProjectScope) {
                throw new BotApiError("credential_invalid", "The Bot credential is ambiguous", "unauthenticated");
            }
            scope = candidate;
        }
        if (!(scope instanceof FoundBotProjectScope)) {
            throw new BotApiError("bot_not_found", "The Bot does not exist", "not-found");
        }
        const access = await this.#projectAuthentication.authorizeProject(
            scope.projectId,
            token,
            permission,
            actorReference,
            signal,
        );
        signal.throwIfAborted();
        if (
            access.scope.storageLocator.resolveHostingPlacement() !== scope.tenantId ||
            access.scope.projectId !== scope.projectId
        ) {
            throw new BotApiError("bot_not_found", "The Bot does not exist", "not-found");
        }
        return new ProjectBotAccess(access, normalizedBotId);
    };

    readonly authorizeProjectConversation = async (
        conversationId: string,
        token: string,
        permission: ProjectPermission,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<ProjectConversationAccess> => {
        const normalizedConversationId = validateIdentifier(conversationId, "conversation_id");
        decodeProjectCredential(token);
        let scope: BotConversationScopeLookup = new MissingBotConversationScope();
        for (const storage of this.#credentials) {
            signal.throwIfAborted();
            const candidate = await storage.readConversationProjectScope(normalizedConversationId, signal);
            signal.throwIfAborted();
            if (candidate instanceof MissingBotConversationScope) {
                continue;
            }
            if (!(candidate instanceof FoundBotConversationScope)) {
                throw new BotApiError(
                    "bot_service_unavailable",
                    "The Conversation Project scope is invalid",
                    "unavailable",
                );
            }
            if (scope instanceof FoundBotConversationScope) {
                throw new BotApiError(
                    "credential_invalid",
                    "The Conversation credential is ambiguous",
                    "unauthenticated",
                );
            }
            scope = candidate;
        }
        if (!(scope instanceof FoundBotConversationScope)) {
            throw new BotApiError("bot_not_found", "The Conversation does not exist", "not-found");
        }
        const access = await this.#projectAuthentication.authorizeProject(
            scope.projectId,
            token,
            permission,
            actorReference,
            signal,
        );
        if (
            access.scope.storageLocator.resolveHostingPlacement() !== scope.tenantId ||
            access.scope.projectId !== scope.projectId
        ) {
            throw new BotApiError("bot_not_found", "The Conversation does not exist", "not-found");
        }
        return new ProjectConversationAccess(access, scope.botId, normalizedConversationId, scope.sessionId);
    };

    readonly authorizeConnector = async (
        connectionId: string,
        token: string,
        requiredScope: string,
        signal: AbortSignal,
    ): Promise<BotConnectionAccess> => {
        const access = await this.authorizeConnectorCredential(connectionId, token, signal);
        if (!access.scopes.has(requiredScope)) {
            throw new BotApiError("scope_denied", "The Bot connection scope is not granted", "access-denied");
        }
        return access;
    };

    readonly authorizeConnectorManagement = async (
        connectionId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<BotConnectionAccess> => await this.authorizeConnectorCredential(connectionId, token, signal);

    private readonly authorizeConnectorCredential = async (
        connectionId: string,
        token: string,
        signal: AbortSignal,
    ): Promise<BotConnectionAccess> => {
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
        return new BotConnectionAccess(
            new ProjectScope(row.tenant_id, row.project_id),
            row.bot_id,
            row.connection_id,
            row.credential_id,
            row.connector_principal_id,
            row.audience,
            scopes,
        );
    };

    private readonly inboundCredentialPlanes = async (
        botId: string,
        tokenDigest: string,
        now: number,
        signal: AbortSignal,
    ): Promise<readonly InboundCredentialPlaneRecord[]> => {
        const pages = await Promise.all(
            this.#credentials.map((storage) => storage.readInboundCredentialPlanes(botId, tokenDigest, now, signal)),
        );
        signal.throwIfAborted();
        return pages.flat();
    };

    readonly authorizeInbound = async (
        botId: string,
        token: string,
        requiredProjectPermission: ProjectPermission,
        requiredConnectorScope: string,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<BotConversationAuthorization> => {
        const projectCredential = decodeProjectCredential(token);
        if (projectCredential.scheme !== ProjectCredentialScheme.Capability) {
            return await this.authorizeProjectBot(botId, token, requiredProjectPermission, actorReference, signal);
        }
        const normalizedBotId = validateIdentifier(botId, "bot_id");
        const tokenDigest = await hashSecret(validateToken(token));
        signal.throwIfAborted();
        const planes = await this.inboundCredentialPlanes(normalizedBotId, tokenDigest, Date.now(), signal);
        const plane = planes[0];
        if (planes.length !== 1 || plane === undefined) {
            throw new BotApiError(
                "conversation_access_denied",
                "The Bot conversation is not accessible",
                "access-denied",
            );
        }
        if (plane.plane === "project") {
            return await this.authorizeProjectBot(
                normalizedBotId,
                token,
                requiredProjectPermission,
                actorReference,
                signal,
            );
        }
        if (plane.plane !== "connector" || typeof plane.connection_id !== "string") {
            throw new BotApiError(
                "conversation_access_denied",
                "The Bot conversation is not accessible",
                "access-denied",
            );
        }
        return await this.authorizeConnector(plane.connection_id, token, requiredConnectorScope, signal);
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
