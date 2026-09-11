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
import type {
    ConversationCredentialInsert,
    ConversationCredentialRow,
    ConversationDirectoryRow,
    ConversationMessageRow,
} from "../entity/conversation-records.ts";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { ConversationAccessStorage } from "../storage/conversation-access-storage.ts";
import type { PlatformControlPlaneService } from "./platform-control-plane-service.ts";

const MINIMUM_LIFETIME_MILLISECONDS = 60 * 1_000;
const MAXIMUM_LIFETIME_MILLISECONDS = 60 * 60 * 1_000;
const CREDENTIAL_PATTERN = /^mconv_([a-zA-Z0-9_-]{22})_([a-zA-Z0-9_-]{43})$/;

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

function recordValue(record: Readonly<Record<string, unknown>>, key: string): unknown {
    return record[key];
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
        const createdAt = recordValue(record, "createdAt");
        const messageId = recordValue(record, "messageId");
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

export class ConversationAccessService implements ConversationAccessAuthorizer {
    readonly #control: PlatformControlPlaneService;
    readonly #storage: ConversationAccessStorage;

    constructor(storage: ConversationAccessStorage, control: PlatformControlPlaneService) {
        this.#storage = storage;
        this.#control = control;
    }

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
        const directory = await this.#storage.readActiveConversationDirectory(normalizedConversationId, signal);
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
        if (access.project.scope.projectId !== directory.project_id) {
            throw new PlatformControlPlaneError(
                "conversation_credential_access_denied",
                "The Conversation belongs to another App",
                403,
            );
        }
        const permissions = decodeConversationPermissions(requestedPermissions);
        this.requirePermissions(access, permissions);
        return await this.insertCredential(
            access.tenantId,
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
        };
        const replacement = await this.createCredential(
            parent.tenantId,
            parent.appId,
            parent.project.credentialId,
            parent.credentialRevision,
            directory,
            source.actor_ref,
            decodedPermissions(source.permissions_json),
            lifetime(expiresInSeconds),
        );
        const now = Date.now();
        const rotated = await this.#storage.rotateCredential(replacement.record, source.credential_id, now, signal);
        if (!rotated) {
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
        const revoked = await this.#storage.revokeCredential(source.credential_id, now, signal);
        if (!revoked) {
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
        const row = await this.#storage.readCredentialByPublicId(publicCredentialId, signal);
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
        const touched = await this.#storage.touchCredential(row.credential_id, now, signal);
        if (!touched) {
            throw new ConversationAccessError(
                "conversation_credential_revoked",
                "The Conversation credential is no longer active",
            );
        }
        return new ConversationAccessContext(
            new ProjectScope(row.project_id),
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
        const changes = await this.#storage.insertMessage(
            {
                actorRef: access.actorReference,
                artifactIdsJson: JSON.stringify(normalizedArtifactIds),
                content,
                conversationId: access.conversationId,
                createdAt: now,
                credentialId: access.credentialId,
                idempotencyKey: normalizedIdempotencyKey,
                imagesJson: JSON.stringify(images),
                messageId,
                projectId: access.scope.projectId,
                requestDigest,
                resourcesJson: JSON.stringify(resources),
                sessionId: access.sessionId,
            },
            signal,
        );
        const row = await this.#storage.readMessageByIdempotencyKey(
            access.scope.projectId,
            access.sessionId,
            normalizedIdempotencyKey,
            signal,
        );
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
        if (changes !== 0 && changes !== 1) {
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
        const row = await this.#storage.readMessage(
            validateIdentifier(messageId, "message_id"),
            access.scope.projectId,
            access.conversationId,
            access.sessionId,
            access.actorReference,
            signal,
        );
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
        const rows = await this.#storage.listMessages(
            access.scope.projectId,
            access.conversationId,
            access.sessionId,
            decoded?.createdAt ?? null,
            decoded?.messageId ?? null,
            limit + 1,
            signal,
        );
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
            acceptedMessages: pageRows.map(messageResource),
            nextCursor: rows.length > limit && last !== undefined ? encodedMessageCursor(last) : null,
        };
    };

    private readonly insertCredential = async (
        tenantId: string,
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
            tenantId,
            appId,
            parentCredentialId,
            parentCredentialRevision,
            directory,
            actorRef,
            permissions,
            lifetimeMilliseconds,
        );
        const inserted = await this.#storage.insertCredential(created.record, signal);
        if (!inserted) {
            throw new PlatformControlPlaneError(
                "platform_write_failed",
                "The Conversation credential could not be issued",
                503,
            );
        }
        return created.resource;
    };

    private readonly requirePermissions = (
        access: Awaited<ReturnType<PlatformControlPlaneService["authorizePlatformCredential"]>>,
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
        tenantId: string,
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
        const permissionList = permissionValues(permissions);
        const record: ConversationCredentialInsert = {
            actorRef,
            appId,
            conversationId: directory.conversation_id,
            credentialId,
            expiresAt,
            issuedAt: now,
            parentCredentialId,
            parentCredentialRevision,
            permissionsJson: JSON.stringify(permissionList),
            projectId: directory.project_id,
            publicCredentialId,
            secretDigest: await hashSecret(credential),
            sessionId: directory.session_id,
            tenantId,
        };
        return {
            record,
            resource: {
                actorRef,
                appId,
                conversationId: directory.conversation_id,
                credential,
                credentialId,
                expiresAt: new Date(expiresAt).toISOString(),
                issuedAt: new Date(now).toISOString(),
                permissions: permissionList,
                projectId: directory.project_id,
                sessionId: directory.session_id,
                tenantId,
            },
        };
    };

    private readonly readById = async (
        credentialId: string,
        signal: AbortSignal,
    ): Promise<ConversationCredentialRow> => {
        const row = await this.#storage.readCredentialById(credentialId, signal);
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
