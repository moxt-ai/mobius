import { relayDrizzle } from "@moxt-ai/mobius-relay-core/database";
import { bot, botConversation } from "@moxt-ai/mobius-relay-core/schema";
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
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
import { conversationAccessCredential, platformConversationMessage } from "../schema/index.ts";
import { waitForD1 } from "./d1-operation.ts";
import { decodeOptionalStorageRecord, decodeStorageRecords } from "./decode-storage-record.ts";
import { PlatformControlPlaneStorage } from "./platform-control-plane-storage.ts";
import { type PlatformDatabaseResolver, projectSqlDatabase } from "./platform-database-resolver.ts";
import { platformDrizzle } from "./platform-drizzle-database.ts";
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

const credentialSelection = {
    credential_id: conversationAccessCredential.credentialId,
    public_credential_id: conversationAccessCredential.publicCredentialId,
    parent_credential_id: conversationAccessCredential.parentCredentialId,
    parent_credential_revision: conversationAccessCredential.parentCredentialRevision,
    tenant_id: conversationAccessCredential.tenantId,
    app_id: conversationAccessCredential.appId,
    project_id: conversationAccessCredential.projectId,
    conversation_id: conversationAccessCredential.conversationId,
    session_id: conversationAccessCredential.sessionId,
    actor_ref: conversationAccessCredential.actorRef,
    permissions_json: conversationAccessCredential.permissionsJson,
    secret_digest: conversationAccessCredential.secretDigest,
    issued_at: conversationAccessCredential.issuedAt,
    expires_at: conversationAccessCredential.expiresAt,
    last_used_at: conversationAccessCredential.lastUsedAt,
    revoked_at: conversationAccessCredential.revokedAt,
};

const messageSelection = {
    message_id: platformConversationMessage.messageId,
    credential_id: platformConversationMessage.credentialId,
    project_id: platformConversationMessage.projectId,
    conversation_id: platformConversationMessage.conversationId,
    session_id: platformConversationMessage.sessionId,
    actor_ref: platformConversationMessage.actorRef,
    idempotency_key: platformConversationMessage.idempotencyKey,
    request_digest: platformConversationMessage.requestDigest,
    content: platformConversationMessage.content,
    images_json: platformConversationMessage.imagesJson,
    resources_json: platformConversationMessage.resourcesJson,
    artifact_ids_json: platformConversationMessage.artifactIdsJson,
    created_at: platformConversationMessage.createdAt,
};

export class ConversationAccessStorage {
    readonly #platformDatabase: D1Database;
    readonly #databases: PlatformDatabaseResolver;
    readonly #control: PlatformControlPlaneStorage;
    readonly #projects: PlatformProjectAuthorizationStorage;

    constructor(platformDatabase: D1Database, databases: PlatformDatabaseResolver) {
        this.#platformDatabase = platformDatabase;
        this.#databases = databases;
        this.#control = new PlatformControlPlaneStorage(platformDatabase, databases);
        this.#projects = new PlatformProjectAuthorizationStorage(databases);
    }

    readonly readActiveConversationDirectory = async (
        projectId: string,
        conversationId: string,
        signal: AbortSignal,
    ): Promise<ConversationDirectoryRow | null> => {
        return decodeOptionalStorageRecord(
            ConversationDirectoryRowSchema,
            (
                await waitForD1(
                    () =>
                        relayDrizzle(projectSqlDatabase(this.#databases, projectId), signal)
                            .select({
                                conversation_id: botConversation.conversationId,
                                session_id: botConversation.sessionId,
                                project_id: bot.projectId,
                            })
                            .from(botConversation)
                            .innerJoin(bot, eq(bot.botId, botConversation.botId))
                            .where(
                                and(
                                    eq(botConversation.conversationId, conversationId),
                                    eq(botConversation.lifecycle, "active"),
                                    eq(bot.lifecycle, "active"),
                                    eq(bot.projectId, projectId),
                                ),
                            )
                            .limit(1),
                    signal,
                )
            )[0] ?? null,
        );
    };

    readonly insertCredential = async (
        credential: ConversationCredentialInsert,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const result = await waitForD1(
            () =>
                relayDrizzle(projectSqlDatabase(this.#databases, credential.projectId), signal)
                    .insert(conversationAccessCredential)
                    .values(this.credentialValues(credential))
                    .returning({ credentialId: conversationAccessCredential.credentialId }),
            signal,
        );
        return result.length === 1;
    };

    readonly rotateCredential = async (
        credential: ConversationCredentialInsert,
        sourceCredentialId: string,
        revokedAt: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const database = relayDrizzle(projectSqlDatabase(this.#databases, credential.projectId), signal);
        const source = await waitForD1(
            () =>
                database
                    .select({ credentialId: conversationAccessCredential.credentialId })
                    .from(conversationAccessCredential)
                    .where(
                        and(
                            eq(conversationAccessCredential.credentialId, sourceCredentialId),
                            eq(conversationAccessCredential.projectId, credential.projectId),
                            isNull(conversationAccessCredential.revokedAt),
                        ),
                    )
                    .limit(1),
            signal,
        );
        if (source.length !== 1) {
            return false;
        }
        const results = await waitForD1(
            () =>
                database.batch([
                    database.insert(conversationAccessCredential).values(this.credentialValues(credential)),
                    database
                        .update(conversationAccessCredential)
                        .set({ revokedAt })
                        .where(
                            and(
                                eq(conversationAccessCredential.credentialId, sourceCredentialId),
                                eq(conversationAccessCredential.projectId, credential.projectId),
                                isNull(conversationAccessCredential.revokedAt),
                            ),
                        ),
                ]),
            signal,
        );
        return results.length === 2;
    };

    readonly revokeCredential = async (
        projectId: string,
        credentialId: string,
        revokedAt: number,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const result = await waitForD1(
            () =>
                relayDrizzle(projectSqlDatabase(this.#databases, projectId), signal)
                    .update(conversationAccessCredential)
                    .set({ revokedAt })
                    .where(
                        and(
                            eq(conversationAccessCredential.credentialId, credentialId),
                            eq(conversationAccessCredential.projectId, projectId),
                            isNull(conversationAccessCredential.revokedAt),
                        ),
                    )
                    .returning({ credentialId: conversationAccessCredential.credentialId }),
            signal,
        );
        return result.length === 1;
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
            (
                await waitForD1(
                    () =>
                        relayDrizzle(projectSqlDatabase(this.#databases, projectId), signal)
                            .select(credentialSelection)
                            .from(conversationAccessCredential)
                            .where(
                                and(
                                    eq(conversationAccessCredential.projectId, projectId),
                                    eq(
                                        column === "credential_id"
                                            ? conversationAccessCredential.credentialId
                                            : conversationAccessCredential.publicCredentialId,
                                        id,
                                    ),
                                ),
                            )
                            .limit(1),
                    signal,
                )
            )[0] ?? null,
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
                relayDrizzle(projectSqlDatabase(this.#databases, projectId), signal)
                    .update(conversationAccessCredential)
                    .set({ lastUsedAt: now })
                    .where(
                        and(
                            eq(conversationAccessCredential.credentialId, credentialId),
                            eq(conversationAccessCredential.projectId, projectId),
                            isNull(conversationAccessCredential.revokedAt),
                            gt(conversationAccessCredential.expiresAt, now),
                        ),
                    )
                    .returning({ credentialId: conversationAccessCredential.credentialId }),
            signal,
        );
        return result.length === 1;
    };

    readonly insertMessage = async (message: ConversationMessageInsert, signal: AbortSignal): Promise<number> => {
        const result = await waitForD1(
            () =>
                platformDrizzle(this.#platformDatabase)
                    .insert(platformConversationMessage)
                    .values({
                        messageId: message.messageId,
                        credentialId: message.credentialId,
                        projectId: message.projectId,
                        conversationId: message.conversationId,
                        sessionId: message.sessionId,
                        actorRef: message.actorRef,
                        idempotencyKey: message.idempotencyKey,
                        requestDigest: message.requestDigest,
                        content: message.content,
                        imagesJson: message.imagesJson,
                        resourcesJson: message.resourcesJson,
                        artifactIdsJson: message.artifactIdsJson,
                        createdAt: message.createdAt,
                    })
                    .onConflictDoNothing()
                    .returning({ messageId: platformConversationMessage.messageId }),
            signal,
        );
        return result.length;
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
                    platformDrizzle(this.#platformDatabase)
                        .select(messageSelection)
                        .from(platformConversationMessage)
                        .where(
                            and(
                                eq(platformConversationMessage.projectId, projectId),
                                eq(platformConversationMessage.sessionId, sessionId),
                                eq(platformConversationMessage.idempotencyKey, idempotencyKey),
                            ),
                        )
                        .limit(1)
                        .then((rows) => rows[0] ?? null),
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
                    platformDrizzle(this.#platformDatabase)
                        .select(messageSelection)
                        .from(platformConversationMessage)
                        .where(
                            and(
                                eq(platformConversationMessage.messageId, messageId),
                                eq(platformConversationMessage.projectId, projectId),
                                eq(platformConversationMessage.conversationId, conversationId),
                                eq(platformConversationMessage.sessionId, sessionId),
                                eq(platformConversationMessage.actorRef, actorRef),
                            ),
                        )
                        .limit(1)
                        .then((rows) => rows[0] ?? null),
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
                platformDrizzle(this.#platformDatabase)
                    .select(messageSelection)
                    .from(platformConversationMessage)
                    .where(
                        and(
                            eq(platformConversationMessage.projectId, projectId),
                            eq(platformConversationMessage.conversationId, conversationId),
                            eq(platformConversationMessage.sessionId, sessionId),
                            cursorCreatedAt === null || cursorMessageId === null
                                ? undefined
                                : or(
                                      lt(platformConversationMessage.createdAt, cursorCreatedAt),
                                      and(
                                          eq(platformConversationMessage.createdAt, cursorCreatedAt),
                                          lt(platformConversationMessage.messageId, cursorMessageId),
                                      ),
                                  ),
                        ),
                    )
                    .orderBy(desc(platformConversationMessage.createdAt), desc(platformConversationMessage.messageId))
                    .limit(limit),
            signal,
        );
        return decodeStorageRecords(ConversationMessageRowSchema, rows);
    };

    private readonly credentialValues = (credential: ConversationCredentialInsert) => ({
        credentialId: credential.credentialId,
        publicCredentialId: credential.publicCredentialId,
        parentCredentialId: credential.parentCredentialId,
        parentCredentialRevision: credential.parentCredentialRevision,
        tenantId: credential.tenantId,
        appId: credential.appId,
        projectId: credential.projectId,
        conversationId: credential.conversationId,
        sessionId: credential.sessionId,
        actorRef: credential.actorRef,
        permissionsJson: credential.permissionsJson,
        secretDigest: credential.secretDigest,
        issuedAt: credential.issuedAt,
        expiresAt: credential.expiresAt,
        lastUsedAt: credential.issuedAt,
    });
}
