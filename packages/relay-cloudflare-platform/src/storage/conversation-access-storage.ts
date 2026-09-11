import type {
    ConversationCredentialInsert,
    ConversationCredentialRow,
    ConversationDirectoryRow,
    ConversationMessageInsert,
    ConversationMessageRow,
} from "../entity/conversation-records.ts";
import {
    ConversationCredentialRowSchema,
    ConversationDirectoryRowSchema,
    ConversationMessageRowSchema,
} from "../entity/conversation-records.ts";
import { decodeOptionalStorageRecord, decodeStorageRecords } from "./decode-storage-record.ts";

async function waitForD1<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const result = await operation();
    signal.throwIfAborted();
    return result;
}

export class ConversationAccessStorage {
    readonly #platformDatabase: D1Database;
    readonly #projectDatabase: D1Database;

    constructor(platformDatabase: D1Database, projectDatabase: D1Database) {
        this.#platformDatabase = platformDatabase;
        this.#projectDatabase = projectDatabase;
    }

    readonly readConversationDirectory = async (
        conversationId: string,
        sessionId: string,
        tenantId: string,
        projectId: string,
        signal: AbortSignal,
    ): Promise<ConversationDirectoryRow | null> =>
        decodeOptionalStorageRecord(
            ConversationDirectoryRowSchema,
            await waitForD1(
                () =>
                    this.#projectDatabase
                        .prepare(
                            `SELECT conversations.conversation_id, conversations.session_id,
                                bots.tenant_id, bots.project_id
                           FROM bot_conversations AS conversations
                           JOIN bots ON bots.bot_id = conversations.bot_id
                          WHERE conversations.conversation_id = ? AND conversations.session_id = ?
                            AND bots.tenant_id = ? AND bots.project_id = ?`,
                        )
                        .bind(conversationId, sessionId, tenantId, projectId)
                        .first(),
                signal,
            ),
        );

    readonly readActiveConversationDirectory = async (
        conversationId: string,
        signal: AbortSignal,
    ): Promise<ConversationDirectoryRow | null> =>
        decodeOptionalStorageRecord(
            ConversationDirectoryRowSchema,
            await waitForD1(
                () =>
                    this.#projectDatabase
                        .prepare(
                            `SELECT conversations.conversation_id, conversations.session_id,
                                bots.tenant_id, bots.project_id
                           FROM bot_conversations AS conversations
                           JOIN bots ON bots.bot_id = conversations.bot_id
                          WHERE conversations.conversation_id = ? AND conversations.lifecycle = 'active'
                            AND bots.lifecycle = 'active'`,
                        )
                        .bind(conversationId)
                        .first(),
                signal,
            ),
        );

    readonly insertCredential = async (
        credential: ConversationCredentialInsert,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const result = await waitForD1(() => this.credentialInsertStatement(credential).run(), signal);
        return result.meta.changes === 1;
    };

    readonly rotateCredential = async (
        credential: ConversationCredentialInsert,
        sourceCredentialId: string,
        revokedAt: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const results = await waitForD1(
            () =>
                this.#platformDatabase.batch([
                    this.credentialInsertStatement(credential),
                    this.#platformDatabase
                        .prepare(
                            "UPDATE conversation_access_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL",
                        )
                        .bind(revokedAt, sourceCredentialId),
                ]),
            signal,
        );
        return results.every((result) => result.meta.changes === 1);
    };

    readonly revokeCredential = async (
        credentialId: string,
        revokedAt: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const result = await waitForD1(
            () =>
                this.#platformDatabase
                    .prepare(
                        "UPDATE conversation_access_credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL",
                    )
                    .bind(revokedAt, credentialId)
                    .run(),
            signal,
        );
        return result.meta.changes === 1;
    };

    readonly readCredentialByPublicId = async (
        publicCredentialId: string,
        signal: AbortSignal,
    ): Promise<ConversationCredentialRow | null> =>
        decodeOptionalStorageRecord(
            ConversationCredentialRowSchema,
            await waitForD1(
                () =>
                    this.#platformDatabase
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
                        .first(),
                signal,
            ),
        );

    readonly readCredentialById = async (
        credentialId: string,
        signal: AbortSignal,
    ): Promise<ConversationCredentialRow | null> =>
        decodeOptionalStorageRecord(
            ConversationCredentialRowSchema,
            await waitForD1(
                () =>
                    this.#platformDatabase
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
                        .first(),
                signal,
            ),
        );

    readonly touchCredential = async (credentialId: string, now: number, signal: AbortSignal): Promise<boolean> => {
        const result = await waitForD1(
            () =>
                this.#platformDatabase
                    .prepare(
                        `UPDATE conversation_access_credentials SET last_used_at = ?
                          WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?`,
                    )
                    .bind(now, credentialId, now)
                    .run(),
            signal,
        );
        return result.meta.changes === 1;
    };

    readonly insertMessage = async (message: ConversationMessageInsert, signal: AbortSignal): Promise<number> => {
        const result = await waitForD1(
            () =>
                this.#platformDatabase
                    .prepare(
                        `INSERT OR IGNORE INTO platform_conversation_messages (
                           message_id, credential_id, project_id, conversation_id, session_id,
                           actor_ref, idempotency_key, request_digest, content, images_json,
                           resources_json, artifact_ids_json, created_at
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .bind(
                        message.messageId,
                        message.credentialId,
                        message.projectId,
                        message.conversationId,
                        message.sessionId,
                        message.actorRef,
                        message.idempotencyKey,
                        message.requestDigest,
                        message.content,
                        message.imagesJson,
                        message.resourcesJson,
                        message.artifactIdsJson,
                        message.createdAt,
                    )
                    .run(),
            signal,
        );
        return result.meta.changes;
    };

    readonly readMessageByIdempotencyKey = async (
        projectId: string,
        sessionId: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<ConversationMessageRow | null> =>
        decodeOptionalStorageRecord(
            ConversationMessageRowSchema,
            await waitForD1(
                () =>
                    this.#platformDatabase
                        .prepare(
                            `SELECT * FROM platform_conversation_messages
                          WHERE project_id = ? AND session_id = ? AND idempotency_key = ?`,
                        )
                        .bind(projectId, sessionId, idempotencyKey)
                        .first(),
                signal,
            ),
        );

    readonly readMessage = async (
        messageId: string,
        projectId: string,
        conversationId: string,
        sessionId: string,
        actorRef: string,
        signal: AbortSignal,
    ): Promise<ConversationMessageRow | null> =>
        decodeOptionalStorageRecord(
            ConversationMessageRowSchema,
            await waitForD1(
                () =>
                    this.#platformDatabase
                        .prepare(
                            `SELECT * FROM platform_conversation_messages
                          WHERE message_id = ? AND project_id = ? AND conversation_id = ? AND session_id = ?
                            AND actor_ref = ?`,
                        )
                        .bind(messageId, projectId, conversationId, sessionId, actorRef)
                        .first(),
                signal,
            ),
        );

    readonly listMessages = async (
        projectId: string,
        conversationId: string,
        sessionId: string,
        cursorCreatedAt: number | null,
        cursorMessageId: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly ConversationMessageRow[]> => {
        const rows = await waitForD1(
            () =>
                this.#platformDatabase
                    .prepare(
                        `SELECT * FROM platform_conversation_messages
                          WHERE project_id = ? AND conversation_id = ? AND session_id = ?
                            AND (? IS NULL OR created_at < ? OR (created_at = ? AND message_id < ?))
                          ORDER BY created_at DESC, message_id DESC
                          LIMIT ?`,
                    )
                    .bind(
                        projectId,
                        conversationId,
                        sessionId,
                        cursorCreatedAt,
                        cursorCreatedAt,
                        cursorCreatedAt,
                        cursorMessageId,
                        limit,
                    )
                    .all(),
            signal,
        );
        return decodeStorageRecords(ConversationMessageRowSchema, rows.results);
    };

    private readonly credentialInsertStatement = (credential: ConversationCredentialInsert): D1PreparedStatement =>
        this.#platformDatabase
            .prepare(
                `INSERT INTO conversation_access_credentials (
                   credential_id, public_credential_id, parent_credential_id,
                   parent_credential_revision, tenant_id, app_id, project_id,
                   conversation_id, session_id, actor_ref, permissions_json,
                   secret_digest, issued_at, expires_at, last_used_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
                credential.credentialId,
                credential.publicCredentialId,
                credential.parentCredentialId,
                credential.parentCredentialRevision,
                credential.tenantId,
                credential.appId,
                credential.projectId,
                credential.conversationId,
                credential.sessionId,
                credential.actorRef,
                credential.permissionsJson,
                credential.secretDigest,
                credential.issuedAt,
                credential.expiresAt,
                credential.issuedAt,
            );
}
