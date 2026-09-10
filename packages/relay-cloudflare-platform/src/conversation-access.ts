import {
    decodePromptImagesValue,
    decodePromptResourcesValue,
    type PromptImage,
    type PromptResource,
} from "@moxt-ai/mobius-protocol";
import {
    type ConversationAccessAuthorizer,
    ConversationAccessContext,
    ConversationAccessError,
    ConversationPermission,
    createRandomToken,
    decodeConversationPermissions,
    ExpiringProjectAccessLifetime,
    hashSecret,
    ProjectPermission,
    ProjectScope,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";
import { type D1PlatformControlPlane, PlatformControlPlaneError } from "./platform-control-plane.ts";

const MINIMUM_LIFETIME_MILLISECONDS = 60 * 1_000;
const MAXIMUM_LIFETIME_MILLISECONDS = 60 * 60 * 1_000;
const CREDENTIAL_PATTERN = /^mconv_([a-zA-Z0-9_-]{22})_([a-zA-Z0-9_-]{43})$/;

interface ConversationCredentialRow {
    readonly actor_ref: string;
    readonly app_id: string;
    readonly app_lifecycle: string;
    readonly conversation_id: string;
    readonly credential_id: string;
    readonly expires_at: number;
    readonly parent_credential_id: string;
    readonly parent_credential_revision: number;
    readonly parent_expires_at: number;
    readonly parent_overlap_ends_at: unknown;
    readonly parent_replaced_by_credential_id: unknown;
    readonly parent_revoked_at: unknown;
    readonly parent_revision: number;
    readonly permissions_json: string;
    readonly project_id: string;
    readonly project_lifecycle: string;
    readonly public_credential_id: string;
    readonly revoked_at: unknown;
    readonly secret_digest: string;
    readonly session_id: string;
    readonly tenant_id: string;
    readonly tenant_lifecycle: string;
}

interface ConversationDirectoryRow {
    readonly conversation_id: string;
    readonly project_id: string;
    readonly session_id: string;
    readonly tenant_id: string;
}

interface ConversationMessageRow {
    readonly actor_ref: string;
    readonly artifact_ids_json: string;
    readonly content: string;
    readonly conversation_id: string;
    readonly created_at: number;
    readonly credential_id: string;
    readonly idempotency_key: string;
    readonly images_json: string;
    readonly message_id: string;
    readonly project_id: string;
    readonly request_digest: string;
    readonly resources_json: string;
    readonly session_id: string;
}

export class ConversationAcceptedMessage {
    readonly actorRef: string;
    readonly artifactIds: readonly string[];
    readonly content: string;
    readonly conversationId: string;
    readonly createdAt: string;
    readonly images: readonly PromptImage[];
    readonly messageId: string;
    readonly resources: readonly PromptResource[];
    readonly sessionId: string;

    constructor(
        row: ConversationMessageRow,
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        artifactIds: readonly string[],
    ) {
        this.actorRef = row.actor_ref;
        this.artifactIds = artifactIds;
        this.content = row.content;
        this.conversationId = row.conversation_id;
        this.createdAt = new Date(row.created_at).toISOString();
        this.images = images;
        this.messageId = row.message_id;
        this.resources = resources;
        this.sessionId = row.session_id;
    }
}

class ConversationMessageCursor {
    readonly createdAt: number;
    readonly messageId: string;

    constructor(createdAt: number, messageId: string) {
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
            throw new PlatformControlPlaneError("invalid_cursor", "The message cursor is invalid", 400);
        }
        this.createdAt = createdAt;
        this.messageId = validateIdentifier(messageId, "message_id");
    }
}

function constantTimeEqual(left: string, right: string): boolean {
    const maximum = Math.max(left.length, right.length);
    let mismatch = left.length ^ right.length;
    for (let index = 0; index < maximum; index += 1) {
        mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
    }
    return mismatch === 0;
}

function actorReference(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length === 0 || normalized.length > 200) {
        throw new PlatformControlPlaneError("invalid_request", "The actor reference is invalid", 400);
    }
    for (const character of normalized) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 31 || codePoint === 127) {
            throw new PlatformControlPlaneError("invalid_request", "The actor reference is invalid", 400);
        }
    }
    return normalized;
}

function lifetime(expiresInSeconds: number): number {
    if (!Number.isSafeInteger(expiresInSeconds)) {
        throw new PlatformControlPlaneError(
            "conversation_credential_lifetime_invalid",
            "The Conversation credential lifetime is invalid",
            400,
        );
    }
    const result = expiresInSeconds * 1_000;
    if (result < MINIMUM_LIFETIME_MILLISECONDS || result > MAXIMUM_LIFETIME_MILLISECONDS) {
        throw new PlatformControlPlaneError(
            "conversation_credential_lifetime_invalid",
            "The Conversation credential lifetime is invalid",
            400,
        );
    }
    return result;
}

function permissionValues(values: ReadonlySet<ConversationPermission>): readonly string[] {
    return Object.freeze([...values].map((permission) => permission.value).sort());
}

function requiredProjectPermission(permission: ConversationPermission): ProjectPermission {
    if (permission.value === "artifact:read") {
        return ProjectPermission.ArtifactRead;
    }
    if (permission.value === "artifact:write") {
        return ProjectPermission.ArtifactWrite;
    }
    if (permission.value === "conversation:turn:cancel") {
        return ProjectPermission.ConversationTurnCancel;
    }
    if (permission.value === "conversation:turn:create" || permission.value === "conversation:message:create") {
        return ProjectPermission.ConversationTurnCreate;
    }
    if (permission.value === "interaction:respond") {
        return ProjectPermission.InteractionRespond;
    }
    if (permission.value === "conversation:configure") {
        return ProjectPermission.SessionWrite;
    }
    return ProjectPermission.ConversationRead;
}

function decodedPermissions(encoded: string): ReadonlySet<ConversationPermission> {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new ConversationAccessError(
            "conversation_authorization_record_invalid",
            "The Conversation credential record is invalid",
            { cause },
        );
    }
    return decodeConversationPermissions(value);
}

function decodedArtifactIds(encoded: string): readonly string[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new PlatformControlPlaneError(
            "platform_record_invalid",
            "The accepted Conversation message is invalid",
            500,
            { cause },
        );
    }
    if (!Array.isArray(value) || value.length > 16 || value.some((entry) => typeof entry !== "string")) {
        throw new PlatformControlPlaneError(
            "platform_record_invalid",
            "The accepted Conversation message is invalid",
            500,
        );
    }
    return Object.freeze(
        value.filter((entry) => typeof entry === "string").map((entry) => validateIdentifier(entry, "artifact_id")),
    );
}

function messageCursor(cursor: string): ConversationMessageCursor {
    try {
        if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
            throw new Error("Invalid cursor alphabet");
        }
        const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
        const padding = "=".repeat((4 - (base64.length % 4)) % 4);
        const value: unknown = JSON.parse(atob(`${base64}${padding}`));
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("Invalid cursor payload");
        }
        const record = Object.freeze(Object.fromEntries(Object.entries(value)));
        if (
            Object.keys(record).length !== 2 ||
            !Object.hasOwn(record, "createdAt") ||
            !Object.hasOwn(record, "messageId")
        ) {
            throw new Error("Invalid cursor shape");
        }
        const createdAt = record["createdAt"];
        const messageId = record["messageId"];
        if (typeof createdAt !== "number" || typeof messageId !== "string") {
            throw new Error("Invalid cursor fields");
        }
        return new ConversationMessageCursor(createdAt, messageId);
    } catch (cause) {
        if (cause instanceof PlatformControlPlaneError) {
            throw cause;
        }
        throw new PlatformControlPlaneError("invalid_cursor", "The message cursor is invalid", 400, { cause });
    }
}

function encodedMessageCursor(row: ConversationMessageRow): string {
    return btoa(JSON.stringify({ createdAt: row.created_at, messageId: row.message_id }))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

function messageResource(row: ConversationMessageRow): ConversationAcceptedMessage {
    let images: readonly PromptImage[];
    let resources: readonly PromptResource[];
    try {
        images = decodePromptImagesValue(JSON.parse(row.images_json));
        resources = decodePromptResourcesValue(JSON.parse(row.resources_json));
    } catch (cause) {
        throw new PlatformControlPlaneError(
            "platform_record_invalid",
            "The accepted Conversation message is invalid",
            500,
            { cause },
        );
    }
    return new ConversationAcceptedMessage(row, images, resources, decodedArtifactIds(row.artifact_ids_json));
}

export class D1ConversationAccess implements ConversationAccessAuthorizer {
    readonly #control: D1PlatformControlPlane;
    readonly #platformDatabase: D1Database;
    readonly #projectDatabase: D1Database;

    constructor(platformDatabase: D1Database, projectDatabase: D1Database, control: D1PlatformControlPlane) {
        this.#platformDatabase = platformDatabase;
        this.#projectDatabase = projectDatabase;
        this.#control = control;
    }

    readonly issue = async (
        projectId: string,
        appCredential: string,
        conversationId: string,
        sessionId: string,
        requestedActorReference: string,
        requestedPermissions: unknown,
        expiresInSeconds: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const normalizedProjectId = validateIdentifier(projectId, "project_id");
        const normalizedConversationId = validateIdentifier(conversationId, "conversation_id");
        const normalizedSessionId = validateIdentifier(sessionId, "session_id");
        const access = await this.#control.authorizePlatformCredential(
            normalizedProjectId,
            appCredential,
            ProjectPermission.ConversationRead,
            requestedActorReference,
            signal,
        );
        const permissions = decodeConversationPermissions(requestedPermissions);
        for (const permission of permissions) {
            if (!access.project.permissions.has(requiredProjectPermission(permission))) {
                throw new PlatformControlPlaneError(
                    "conversation_permission_escalation",
                    "The Conversation credential cannot exceed its parent AppCredential",
                    403,
                );
            }
        }
        const directory = await this.#projectDatabase
            .prepare(
                `SELECT conversations.conversation_id, conversations.session_id,
                        bots.tenant_id, bots.project_id
                   FROM bot_conversations AS conversations
                   JOIN bots ON bots.bot_id = conversations.bot_id
                  WHERE conversations.conversation_id = ? AND conversations.session_id = ?
                    AND bots.tenant_id = ? AND bots.project_id = ?`,
            )
            .bind(
                normalizedConversationId,
                normalizedSessionId,
                access.project.scope.storageLocator.resolveHostingPlacement(),
                access.project.scope.projectId,
            )
            .first<ConversationDirectoryRow>();
        signal.throwIfAborted();
        if (directory === null) {
            throw new PlatformControlPlaneError(
                "conversation_not_found",
                "The Conversation was not found in this Project",
                404,
            );
        }
        return await this.insertCredential(
            access.appId,
            access.project.credentialId,
            access.credentialRevision,
            directory,
            actorReference(requestedActorReference),
            permissions,
            lifetime(expiresInSeconds),
            signal,
        );
    };

    readonly issueForConversation = async (
        conversationId: string,
        appCredential: string,
        requestedActorReference: string,
        requestedPermissions: unknown,
        expiresInSeconds: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const normalizedConversationId = validateIdentifier(conversationId, "conversation_id");
        const directory = await this.#projectDatabase
            .prepare(
                `SELECT conversations.conversation_id, conversations.session_id,
                        bots.tenant_id, bots.project_id
                   FROM bot_conversations AS conversations
                   JOIN bots ON bots.bot_id = conversations.bot_id
                  WHERE conversations.conversation_id = ? AND conversations.lifecycle = 'active'
                    AND bots.lifecycle = 'active'`,
            )
            .bind(normalizedConversationId)
            .first<ConversationDirectoryRow>();
        signal.throwIfAborted();
        if (directory === null) {
            throw new PlatformControlPlaneError("conversation_not_found", "The Conversation was not found", 404);
        }
        const access = await this.#control.authorizePlatformCredential(
            directory.project_id,
            appCredential,
            ProjectPermission.ConversationRead,
            requestedActorReference,
            signal,
        );
        if (access.project.scope.storageLocator.resolveHostingPlacement() !== directory.tenant_id) {
            throw new PlatformControlPlaneError(
                "conversation_credential_access_denied",
                "The Conversation belongs to another App",
                403,
            );
        }
        const permissions = decodeConversationPermissions(requestedPermissions);
        this.requirePermissions(access, permissions);
        return await this.insertCredential(
            access.appId,
            access.project.credentialId,
            access.credentialRevision,
            directory,
            actorReference(requestedActorReference),
            permissions,
            lifetime(expiresInSeconds),
            signal,
        );
    };

    readonly rotate = async (
        credentialId: string,
        appCredential: string,
        expiresInSeconds: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const source = await this.readById(validateIdentifier(credentialId, "credential_id"), signal);
        const parent = await this.#control.authorizePlatformCredential(
            source.project_id,
            appCredential,
            ProjectPermission.ConversationRead,
            source.actor_ref,
            signal,
        );
        if (parent.appId !== source.app_id) {
            throw new PlatformControlPlaneError(
                "conversation_credential_access_denied",
                "The Conversation credential belongs to another App",
                403,
            );
        }
        const directory: ConversationDirectoryRow = {
            conversation_id: source.conversation_id,
            project_id: source.project_id,
            session_id: source.session_id,
            tenant_id: source.tenant_id,
        };
        const replacement = await this.createCredential(
            parent.appId,
            parent.project.credentialId,
            parent.credentialRevision,
            directory,
            source.actor_ref,
            decodedPermissions(source.permissions_json),
            lifetime(expiresInSeconds),
        );
        const now = Date.now();
        const results = await this.#platformDatabase.batch([
            replacement.statement,
            this.#platformDatabase
                .prepare(
                    "UPDATE conversation_access_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL",
                )
                .bind(now, source.credential_id),
        ]);
        signal.throwIfAborted();
        if (results.some((result) => result.meta.changes !== 1)) {
            throw new PlatformControlPlaneError(
                "conversation_credential_rotation_conflict",
                "The Conversation credential was already rotated or revoked",
                409,
            );
        }
        return { ...replacement.resource, replacedCredentialId: source.credential_id };
    };

    readonly revoke = async (credentialId: string, appCredential: string, signal: AbortSignal): Promise<object> => {
        signal.throwIfAborted();
        const source = await this.readById(validateIdentifier(credentialId, "credential_id"), signal);
        const parent = await this.#control.authorizePlatformCredential(
            source.project_id,
            appCredential,
            ProjectPermission.ConversationRead,
            source.actor_ref,
            signal,
        );
        if (parent.appId !== source.app_id) {
            throw new PlatformControlPlaneError(
                "conversation_credential_access_denied",
                "The Conversation credential belongs to another App",
                403,
            );
        }
        const now = Date.now();
        const result = await this.#platformDatabase
            .prepare(
                "UPDATE conversation_access_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL",
            )
            .bind(now, source.credential_id)
            .run();
        signal.throwIfAborted();
        if (result.meta.changes !== 1) {
            throw new PlatformControlPlaneError(
                "conversation_credential_not_found",
                "The Conversation credential was not found",
                404,
            );
        }
        return { credentialId: source.credential_id, revokedAt: new Date(now).toISOString() };
    };

    readonly authorize = async (
        credential: string,
        requiredPermission: ConversationPermission,
        signal: AbortSignal,
    ): Promise<ConversationAccessContext> => {
        signal.throwIfAborted();
        const match = CREDENTIAL_PATTERN.exec(credential);
        const publicCredentialId = match?.[1] ?? "";
        if (publicCredentialId.length === 0) {
            throw new ConversationAccessError(
                "conversation_credential_invalid",
                "The Conversation credential is invalid",
            );
        }
        const row = await this.#platformDatabase
            .prepare(
                `SELECT access.*, parent.revision AS parent_revision,
                        parent.expires_at AS parent_expires_at,
                        parent.replaced_by_credential_id AS parent_replaced_by_credential_id,
                        parent.overlap_ends_at AS parent_overlap_ends_at,
                        parent.revoked_at AS parent_revoked_at,
                        apps.lifecycle AS app_lifecycle,
                        projects.lifecycle AS project_lifecycle,
                        tenants.lifecycle AS tenant_lifecycle
                   FROM conversation_access_credentials AS access
                   JOIN platform_app_credentials AS parent
                     ON parent.credential_id = access.parent_credential_id
                   JOIN platform_apps AS apps ON apps.app_id = access.app_id
                   JOIN platform_projects AS projects ON projects.project_id = access.project_id
                   JOIN platform_tenants AS tenants ON tenants.tenant_id = access.tenant_id
                  WHERE access.public_credential_id = ?`,
            )
            .bind(publicCredentialId)
            .first<ConversationCredentialRow>();
        signal.throwIfAborted();
        if (row === null || !constantTimeEqual(await hashSecret(credential), row.secret_digest)) {
            throw new ConversationAccessError(
                "conversation_credential_invalid",
                "The Conversation credential is invalid",
            );
        }
        const now = Date.now();
        if (
            row.revoked_at !== null ||
            row.expires_at <= now ||
            row.parent_revoked_at !== null ||
            row.parent_expires_at <= now ||
            row.parent_revision !== row.parent_credential_revision ||
            (row.parent_replaced_by_credential_id !== null &&
                (typeof row.parent_overlap_ends_at !== "number" || row.parent_overlap_ends_at <= now)) ||
            row.app_lifecycle !== "active" ||
            row.project_lifecycle !== "active" ||
            row.tenant_lifecycle !== "active"
        ) {
            throw new ConversationAccessError(
                "conversation_credential_revoked",
                "The Conversation credential is no longer active",
            );
        }
        const permissions = decodedPermissions(row.permissions_json);
        if (!permissions.has(requiredPermission)) {
            throw new ConversationAccessError(
                "conversation_permission_denied",
                "The Conversation credential does not grant this operation",
            );
        }
        const touched = await this.#platformDatabase
            .prepare(
                `UPDATE conversation_access_credentials SET last_used_at = ?
                  WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?`,
            )
            .bind(now, row.credential_id, now)
            .run();
        signal.throwIfAborted();
        if (touched.meta.changes !== 1) {
            throw new ConversationAccessError(
                "conversation_credential_revoked",
                "The Conversation credential is no longer active",
            );
        }
        return new ConversationAccessContext(
            new ProjectScope(row.tenant_id, row.project_id),
            row.conversation_id,
            row.session_id,
            row.credential_id,
            row.actor_ref,
            permissions,
            new ExpiringProjectAccessLifetime(row.expires_at),
        );
    };

    readonly createMessage = async (
        access: ConversationAccessContext,
        idempotencyKey: string,
        content: string,
        images: readonly PromptImage[],
        resources: readonly PromptResource[],
        artifactIds: readonly string[],
        now: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        access.require(ConversationPermission.MessageCreate);
        const normalizedIdempotencyKey = validateIdentifier(idempotencyKey, "idempotency_key");
        const normalizedArtifactIds = artifactIds.map((artifactId) => validateIdentifier(artifactId, "artifact_id"));
        const requestDigest = await hashSecret(
            JSON.stringify({ artifactIds: normalizedArtifactIds, content, images, resources }),
        );
        const messageId = `msg_${createRandomToken(18)}`;
        const result = await this.#platformDatabase
            .prepare(
                `INSERT OR IGNORE INTO platform_conversation_messages (
                   message_id, credential_id, project_id, conversation_id, session_id,
                   actor_ref, idempotency_key, request_digest, content, images_json,
                   resources_json, artifact_ids_json, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                messageId,
                access.credentialId,
                access.scope.projectId,
                access.conversationId,
                access.sessionId,
                access.actorReference,
                normalizedIdempotencyKey,
                requestDigest,
                content,
                JSON.stringify(images),
                JSON.stringify(resources),
                JSON.stringify(normalizedArtifactIds),
                now,
            )
            .run();
        signal.throwIfAborted();
        const row = await this.#platformDatabase
            .prepare(
                `SELECT * FROM platform_conversation_messages
                  WHERE project_id = ? AND session_id = ? AND idempotency_key = ?`,
            )
            .bind(access.scope.projectId, access.sessionId, normalizedIdempotencyKey)
            .first<ConversationMessageRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PlatformControlPlaneError(
                "platform_write_failed",
                "The Conversation message could not be accepted",
                503,
            );
        }
        if (
            row.request_digest !== requestDigest ||
            row.conversation_id !== access.conversationId ||
            row.actor_ref !== access.actorReference
        ) {
            throw new PlatformControlPlaneError(
                "idempotency_conflict",
                "The message idempotency key was used with another request",
                409,
            );
        }
        if (result.meta.changes !== 0 && result.meta.changes !== 1) {
            throw new PlatformControlPlaneError(
                "platform_write_failed",
                "The Conversation message could not be accepted",
                503,
            );
        }
        return messageResource(row);
    };

    readonly readMessage = async (
        access: ConversationAccessContext,
        messageId: string,
        signal: AbortSignal,
    ): Promise<ConversationAcceptedMessage> => {
        signal.throwIfAborted();
        access.require(ConversationPermission.Read);
        const row = await this.#platformDatabase
            .prepare(
                `SELECT * FROM platform_conversation_messages
                  WHERE message_id = ? AND project_id = ? AND conversation_id = ? AND session_id = ?
                    AND actor_ref = ?`,
            )
            .bind(
                validateIdentifier(messageId, "message_id"),
                access.scope.projectId,
                access.conversationId,
                access.sessionId,
                access.actorReference,
            )
            .first<ConversationMessageRow>();
        signal.throwIfAborted();
        if (row === null) {
            throw new PlatformControlPlaneError("message_not_found", "The Conversation message was not found", 404);
        }
        return messageResource(row);
    };

    readonly listMessages = async (
        access: ConversationAccessContext,
        requestedCursor: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        access.require(ConversationPermission.Read);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new PlatformControlPlaneError("invalid_page_size", "The message page size is invalid", 400);
        }
        const decoded = requestedCursor.length === 0 ? null : messageCursor(requestedCursor);
        const rows = await this.#platformDatabase
            .prepare(
                `SELECT * FROM platform_conversation_messages
                  WHERE project_id = ? AND conversation_id = ? AND session_id = ?
                    AND (? IS NULL OR created_at < ? OR (created_at = ? AND message_id < ?))
                  ORDER BY created_at DESC, message_id DESC
                  LIMIT ?`,
            )
            .bind(
                access.scope.projectId,
                access.conversationId,
                access.sessionId,
                decoded?.createdAt ?? null,
                decoded?.createdAt ?? null,
                decoded?.createdAt ?? null,
                decoded?.messageId ?? null,
                limit + 1,
            )
            .all<ConversationMessageRow>();
        signal.throwIfAborted();
        const pageRows = rows.results.slice(0, limit);
        const last = pageRows.at(-1);
        return {
            acceptedMessages: pageRows.map(messageResource),
            nextCursor: rows.results.length > limit && last !== undefined ? encodedMessageCursor(last) : null,
        };
    };

    private readonly insertCredential = async (
        appId: string,
        parentCredentialId: string,
        parentCredentialRevision: number,
        directory: ConversationDirectoryRow,
        actorRef: string,
        permissions: ReadonlySet<ConversationPermission>,
        lifetimeMilliseconds: number,
        signal: AbortSignal,
    ): Promise<object> => {
        const created = await this.createCredential(
            appId,
            parentCredentialId,
            parentCredentialRevision,
            directory,
            actorRef,
            permissions,
            lifetimeMilliseconds,
        );
        const result = await created.statement.run();
        signal.throwIfAborted();
        if (result.meta.changes !== 1) {
            throw new PlatformControlPlaneError(
                "platform_write_failed",
                "The Conversation credential could not be issued",
                503,
            );
        }
        return created.resource;
    };

    private readonly requirePermissions = (
        access: Awaited<ReturnType<D1PlatformControlPlane["authorizePlatformCredential"]>>,
        permissions: ReadonlySet<ConversationPermission>,
    ): void => {
        for (const permission of permissions) {
            if (!access.project.permissions.has(requiredProjectPermission(permission))) {
                throw new PlatformControlPlaneError(
                    "conversation_permission_escalation",
                    "The Conversation credential cannot exceed its parent AppCredential",
                    403,
                );
            }
        }
    };

    private readonly createCredential = async (
        appId: string,
        parentCredentialId: string,
        parentCredentialRevision: number,
        directory: ConversationDirectoryRow,
        actorRef: string,
        permissions: ReadonlySet<ConversationPermission>,
        lifetimeMilliseconds: number,
    ) => {
        const now = Date.now();
        const publicCredentialId = createRandomToken(16);
        const credentialId = `cac_${publicCredentialId}`;
        const credential = `mconv_${publicCredentialId}_${createRandomToken(32)}`;
        const expiresAt = now + lifetimeMilliseconds;
        return {
            resource: {
                actorRef,
                appId,
                conversationId: directory.conversation_id,
                credential,
                credentialId,
                expiresAt: new Date(expiresAt).toISOString(),
                issuedAt: new Date(now).toISOString(),
                permissions: permissionValues(permissions),
                projectId: directory.project_id,
                sessionId: directory.session_id,
                tenantId: directory.tenant_id,
            },
            statement: this.#platformDatabase
                .prepare(
                    `INSERT INTO conversation_access_credentials (
                       credential_id, public_credential_id, parent_credential_id,
                       parent_credential_revision, tenant_id, app_id, project_id,
                       conversation_id, session_id, actor_ref, permissions_json,
                       secret_digest, issued_at, expires_at, last_used_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                    credentialId,
                    publicCredentialId,
                    parentCredentialId,
                    parentCredentialRevision,
                    directory.tenant_id,
                    appId,
                    directory.project_id,
                    directory.conversation_id,
                    directory.session_id,
                    actorRef,
                    JSON.stringify(permissionValues(permissions)),
                    await hashSecret(credential),
                    now,
                    expiresAt,
                    now,
                ),
        };
    };

    private readonly readById = async (
        credentialId: string,
        signal: AbortSignal,
    ): Promise<ConversationCredentialRow> => {
        const row = await this.#platformDatabase
            .prepare(
                `SELECT access.*, parent.revision AS parent_revision,
                        parent.expires_at AS parent_expires_at,
                        parent.replaced_by_credential_id AS parent_replaced_by_credential_id,
                        parent.overlap_ends_at AS parent_overlap_ends_at,
                        parent.revoked_at AS parent_revoked_at,
                        apps.lifecycle AS app_lifecycle,
                        projects.lifecycle AS project_lifecycle,
                        tenants.lifecycle AS tenant_lifecycle
                   FROM conversation_access_credentials AS access
                   JOIN platform_app_credentials AS parent
                     ON parent.credential_id = access.parent_credential_id
                   JOIN platform_apps AS apps ON apps.app_id = access.app_id
                   JOIN platform_projects AS projects ON projects.project_id = access.project_id
                   JOIN platform_tenants AS tenants ON tenants.tenant_id = access.tenant_id
                  WHERE access.credential_id = ?`,
            )
            .bind(credentialId)
            .first<ConversationCredentialRow>();
        signal.throwIfAborted();
        if (row === null || row.revoked_at !== null) {
            throw new PlatformControlPlaneError(
                "conversation_credential_not_found",
                "The Conversation credential was not found",
                404,
            );
        }
        return row;
    };
}
