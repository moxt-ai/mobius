import * as v from "valibot";
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
import { waitForD1 } from "./d1-operation.ts";
import { decodeOptionalStorageRecord, decodeStorageRecords } from "./decode-storage-record.ts";
import { PlatformControlPlaneStorage } from "./platform-control-plane-storage.ts";
import { type PlatformDatabaseBinding, projectDatabase } from "./platform-database-resolver.ts";
import { PlatformProjectAuthorizationStorage } from "./platform-project-authorization-storage.ts";

const storedCredentialSchema = v.omit(ConversationCredentialRowSchema, [
    "parent_revision",
    "parent_replaced_by_credential_id",
    "parent_overlap_ends_at",
    "parent_revoked_at",
    "app_lifecycle",
    "project_lifecycle",
    "tenant_lifecycle",
]);

export class ConversationAccessStorage {
    readonly #platformDatabase: D1Database;
    readonly #shards: readonly PlatformDatabaseBinding[];
    readonly #control: PlatformControlPlaneStorage;
    readonly #projects: PlatformProjectAuthorizationStorage;

    constructor(platformDatabase: D1Database, shards: readonly PlatformDatabaseBinding[]) {
        this.#platformDatabase = platformDatabase;
        this.#shards = shards;
        this.#control = new PlatformControlPlaneStorage(platformDatabase, shards);
        this.#projects = new PlatformProjectAuthorizationStorage(shards);
    }

    readonly readActiveConversationDirectory = async (
        projectId: string,
        conversationId: string,
        signal: AbortSignal,
    ): Promise<ConversationDirectoryRow | null> => {
        return decodeOptionalStorageRecord(
            ConversationDirectoryRowSchema,
            await waitForD1(
                () =>
                    projectDatabase(this.#shards, projectId)
                        .prepare(
                            `SELECT conversations.conversation_id, conversations.session_id,
                                 bots.project_id
                           FROM bot_conversations AS conversations
                            JOIN bots ON bots.bot_id = conversations.bot_id
                          WHERE conversations.conversation_id = ? AND conversations.lifecycle = 'active'
                             AND bots.lifecycle = 'active' AND bots.project_id = ?`,
                        )
                        .bind(conversationId, projectId)
                        .first(),
                signal,
            ),
        );
    };

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
        const database = projectDatabase(this.#shards, credential.projectId);
        const results = await waitForD1(
            () =>
                database.batch([
                    this.credentialInsertStatement(credential),
                    database
                        .prepare(
                            "UPDATE conversation_access_credentials SET revoked_at = ? WHERE credential_id = ? AND project_id = ? AND revoked_at IS NULL",
                        )
                        .bind(revokedAt, sourceCredentialId, credential.projectId),
                ]),
            signal,
        );
        return results.every((result) => result.meta.changes === 1);
    };

    readonly revokeCredential = async (
        projectId: string,
        credentialId: string,
        revokedAt: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const result = await waitForD1(
            () =>
                projectDatabase(this.#shards, projectId)
                    .prepare(
                        "UPDATE conversation_access_credentials SET revoked_at = ? WHERE credential_id = ? AND project_id = ? AND revoked_at IS NULL",
                    )
                    .bind(revokedAt, credentialId, projectId)
                    .run(),
            signal,
        );
        return result.meta.changes === 1;
    };

    readonly readCredentialByPublicId = async (
        projectId: string,
        publicCredentialId: string,
        signal: AbortSignal,
    ): Promise<ConversationCredentialRow | null> =>
        this.readCredential(projectId, "public_credential_id", publicCredentialId, signal);

    readonly readCredentialById = async (
        projectId: string,
        credentialId: string,
        signal: AbortSignal,
    ): Promise<ConversationCredentialRow | null> =>
        this.readCredential(projectId, "credential_id", credentialId, signal);

    private readonly readCredential = async (
        projectId: string,
        column: "credential_id" | "public_credential_id",
        id: string,
        signal: AbortSignal,
    ): Promise<ConversationCredentialRow | null> => {
        const row = decodeOptionalStorageRecord(
            storedCredentialSchema,
            await waitForD1(
                () =>
                    projectDatabase(this.#shards, projectId)
                        .prepare(`SELECT * FROM conversation_access_credentials WHERE project_id = ? AND ${column} = ?`)
                        .bind(projectId, id)
                        .first(),
                signal,
            ),
        );
        if (row === null) {
            return null;
        }
        const parent = await this.#control.readCredentialById(row.parent_credential_id, signal);
        const project = await this.#projects.read(row.project_id, signal);
        if (
            parent === null ||
            project === null ||
            parent.app_id !== row.app_id ||
            parent.tenant_id !== row.tenant_id ||
            project.app_id !== row.app_id ||
            project.tenant_id !== row.tenant_id ||
            (parent.all_projects !== 1 &&
                !(await this.#control.credentialHasProject(parent.credential_id, row.project_id, signal)))
        ) {
            return null;
        }
        return v.parse(ConversationCredentialRowSchema, {
            ...row,
            parent_revision: parent.revision,
            parent_replaced_by_credential_id: parent.replaced_by_credential_id,
            parent_overlap_ends_at: parent.overlap_ends_at,
            parent_revoked_at: parent.revoked_at,
            app_lifecycle: parent.app_lifecycle,
            tenant_lifecycle: parent.tenant_lifecycle,
            project_lifecycle: project.lifecycle,
        });
    };

    readonly touchCredential = async (
        projectId: string,
        credentialId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const result = await waitForD1(
            () =>
                projectDatabase(this.#shards, projectId)
                    .prepare(
                        `UPDATE conversation_access_credentials SET last_used_at = ?
                          WHERE credential_id = ? AND project_id = ? AND revoked_at IS NULL AND expires_at > ?`,
                    )
                    .bind(now, credentialId, projectId, now)
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
        projectDatabase(this.#shards, credential.projectId)
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
