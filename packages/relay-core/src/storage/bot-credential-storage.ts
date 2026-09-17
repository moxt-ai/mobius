import { and, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import type { BotGrantCredential } from "../entity/bot/bot-grant.ts";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import {
    bot,
    botConnection,
    botConnectionCredential,
    botConnectionGrant,
    botConversation,
    botExecutionBinding,
    botExecutionDirectory,
    channelHostCredential,
    pairingChannel,
    projectBrowserCredential,
    projectOwnerCredential,
} from "../schema/index.ts";
import {
    type BotConversationScopeRecord,
    type BotCredentialRecords,
    FoundBotConversationScope,
    type InboundCredentialPlaneRecord,
    MissingBotConversationScope,
} from "./bot-credential-records.ts";

export class BotCredentialStorage implements BotCredentialRecords {
    readonly #database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly readGrant = async (
        grantId: string,
        digest: string,
        audience: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const [row] = await relayDrizzle(this.#database, signal)
            .select({
                bot_id: botConnectionGrant.botId,
                audience: botConnectionGrant.audience,
                label: botConnectionGrant.label,
                scopes_json: botConnectionGrant.scopesJson,
                expires_at: botConnectionGrant.expiresAt,
                project_id: bot.projectId,
            })
            .from(botConnectionGrant)
            .innerJoin(bot, eq(bot.botId, botConnectionGrant.botId))
            .where(
                and(
                    eq(botConnectionGrant.grantId, grantId),
                    eq(botConnectionGrant.secretDigest, digest),
                    eq(botConnectionGrant.audience, audience),
                    isNull(botConnectionGrant.consumedAt),
                    gt(botConnectionGrant.expiresAt, now),
                ),
            )
            .limit(1);
        signal.throwIfAborted();
        return (row ?? null) satisfies BotGrantCredential | null;
    };

    readonly botExists: BotCredentialRecords["botExists"] = async (botId, signal) =>
        (
            await relayDrizzle(this.#database, signal)
                .select({ botId: bot.botId })
                .from(bot)
                .where(eq(bot.botId, botId))
                .limit(1)
        ).length > 0;

    readonly botExistsInProject: BotCredentialRecords["botExistsInProject"] = async (botId, projectId, signal) =>
        (
            await relayDrizzle(this.#database, signal)
                .select({ botId: bot.botId })
                .from(bot)
                .where(and(eq(bot.botId, botId), eq(bot.projectId, projectId)))
                .limit(1)
        ).length > 0;

    readonly readConversationProjectScope: BotCredentialRecords["readConversationProjectScope"] = async (
        conversationId,
        signal,
    ) => {
        const [row] = await relayDrizzle(this.#database, signal)
            .select({
                bot_id: botConversation.botId,
                session_id: botConversation.sessionId,
                project_id: bot.projectId,
            })
            .from(botConversation)
            .innerJoin(bot, eq(bot.botId, botConversation.botId))
            .where(eq(botConversation.conversationId, conversationId))
            .limit(1);
        const record: BotConversationScopeRecord | undefined = row;
        return record === undefined
            ? new MissingBotConversationScope()
            : new FoundBotConversationScope(record.project_id, record.bot_id, record.session_id);
    };

    readonly readConnector: BotCredentialRecords["readConnector"] = async (connectionId, digest, now, signal) => {
        const [row] = await relayDrizzle(this.#database, signal)
            .select({
                connection_id: botConnection.connectionId,
                bot_id: botConnection.botId,
                connector_principal_id: botConnection.connectorPrincipalId,
                audience: botConnection.audience,
                scopes_json: botConnection.scopesJson,
                credential_id: botConnectionCredential.credentialId,
                expires_at: botConnectionCredential.expiresAt,
                project_id: bot.projectId,
            })
            .from(botConnection)
            .innerJoin(botConnectionCredential, eq(botConnectionCredential.connectionId, botConnection.connectionId))
            .innerJoin(bot, eq(bot.botId, botConnection.botId))
            .where(
                and(
                    eq(botConnection.connectionId, connectionId),
                    eq(botConnection.lifecycle, "active"),
                    eq(botConnectionCredential.secretDigest, digest),
                    isNull(botConnectionCredential.revokedAt),
                    gt(botConnectionCredential.expiresAt, now),
                ),
            )
            .limit(1);
        return row ?? null;
    };

    readonly readConnectionLifecycle: BotCredentialRecords["readConnectionLifecycle"] = async (
        connectionId,
        signal,
    ) => {
        const [row] = await relayDrizzle(this.#database, signal)
            .select({ lifecycle: botConnection.lifecycle })
            .from(botConnection)
            .where(eq(botConnection.connectionId, connectionId))
            .limit(1);
        return row?.lifecycle ?? null;
    };

    readonly recordConnectionUse: BotCredentialRecords["recordConnectionUse"] = async (
        credentialId,
        connectionId,
        now,
        signal,
    ) => {
        const database = relayDrizzle(this.#database, signal);
        const [credentials, connections] = await Promise.all([
            database
                .select({ credentialId: botConnectionCredential.credentialId })
                .from(botConnectionCredential)
                .where(
                    and(
                        eq(botConnectionCredential.credentialId, credentialId),
                        isNull(botConnectionCredential.revokedAt),
                        gt(botConnectionCredential.expiresAt, now),
                    ),
                )
                .limit(1),
            database
                .select({ connectionId: botConnection.connectionId })
                .from(botConnection)
                .where(and(eq(botConnection.connectionId, connectionId), eq(botConnection.lifecycle, "active")))
                .limit(1),
        ]);
        if (credentials.length !== 1 || connections.length !== 1) {
            return false;
        }
        await database.batch([
            database
                .update(botConnectionCredential)
                .set({ lastUsedAt: now })
                .where(
                    and(
                        eq(botConnectionCredential.credentialId, credentialId),
                        isNull(botConnectionCredential.revokedAt),
                        gt(botConnectionCredential.expiresAt, now),
                    ),
                ),
            database
                .update(botConnection)
                .set({ lastUsedAt: now })
                .where(and(eq(botConnection.connectionId, connectionId), eq(botConnection.lifecycle, "active"))),
        ]);
        return true;
    };

    readonly readInboundCredentialPlanes: BotCredentialRecords["readInboundCredentialPlanes"] = async (
        botId,
        digest,
        now,
        signal,
    ) => {
        const database = relayDrizzle(this.#database, signal);
        const [owners, browsers, hosts, connectors] = await Promise.all([
            database
                .select({ connection_id: projectOwnerCredential.replacedByCredentialId })
                .from(bot)
                .innerJoin(projectOwnerCredential, eq(projectOwnerCredential.projectId, bot.projectId))
                .where(
                    and(
                        eq(bot.botId, botId),
                        eq(projectOwnerCredential.tokenHash, digest),
                        isNull(projectOwnerCredential.revokedAt),
                        or(
                            isNull(projectOwnerCredential.replacedByCredentialId),
                            gt(projectOwnerCredential.overlapEndsAt, now),
                        ),
                    ),
                ),
            database
                .select({ connection_id: projectBrowserCredential.revokedAt })
                .from(bot)
                .innerJoin(projectBrowserCredential, eq(projectBrowserCredential.projectId, bot.projectId))
                .where(
                    and(
                        eq(bot.botId, botId),
                        eq(projectBrowserCredential.tokenHash, digest),
                        isNull(projectBrowserCredential.revokedAt),
                        gt(projectBrowserCredential.expiresAt, now),
                    ),
                ),
            database
                .select({ connection_id: channelHostCredential.replacedByCredentialId })
                .from(bot)
                .innerJoin(pairingChannel, eq(pairingChannel.projectId, bot.projectId))
                .innerJoin(channelHostCredential, eq(channelHostCredential.channelId, pairingChannel.channelId))
                .where(
                    and(
                        eq(bot.botId, botId),
                        eq(channelHostCredential.tokenHash, digest),
                        eq(channelHostCredential.authority, "linked"),
                        isNull(channelHostCredential.revokedAt),
                        eq(pairingChannel.status, "paired"),
                        or(
                            isNull(channelHostCredential.replacedByCredentialId),
                            gt(channelHostCredential.overlapEndsAt, now),
                        ),
                    ),
                ),
            database
                .select({ connection_id: botConnection.connectionId })
                .from(botConnection)
                .innerJoin(
                    botConnectionCredential,
                    eq(botConnectionCredential.connectionId, botConnection.connectionId),
                )
                .where(and(eq(botConnection.botId, botId), eq(botConnectionCredential.secretDigest, digest))),
        ]);
        const projectRows: readonly InboundCredentialPlaneRecord[] = [...owners, ...browsers, ...hosts].map(() => ({
            plane: "project",
            connection_id: null,
        }));
        return [...projectRows, ...connectors.map((row) => ({ plane: "connector", connection_id: row.connection_id }))];
    };

    readonly readRuntimeExecution: BotCredentialRecords["readRuntimeExecution"] = async (
        executionId,
        digest,
        signal,
    ) => {
        const [row] = await relayDrizzle(this.#database, signal)
            .select({
                execution_id: botExecutionDirectory.executionId,
                bot_id: botExecutionDirectory.botId,
                conversation_id: botExecutionDirectory.conversationId,
                turn_id: botExecutionDirectory.turnId,
                session_id: botExecutionDirectory.sessionId,
                behavior_revision_id: botExecutionDirectory.behaviorRevisionId,
                binding_id: botExecutionDirectory.bindingId,
                binding_revision: botExecutionDirectory.bindingRevision,
                runtime_id: botExecutionDirectory.runtimeId,
                capability_id: botExecutionDirectory.capabilityId,
                project_id: bot.projectId,
                bot_lifecycle: bot.lifecycle,
                channel_id: pairingChannel.channelId,
                pairing_id: pairingChannel.pairingId,
                local_grant_id: botExecutionBinding.localGrantId,
            })
            .from(botExecutionDirectory)
            .innerJoin(bot, eq(bot.botId, botExecutionDirectory.botId))
            .innerJoin(
                botExecutionBinding,
                and(
                    eq(botExecutionBinding.bindingId, botExecutionDirectory.bindingId),
                    eq(botExecutionBinding.botId, botExecutionDirectory.botId),
                    eq(botExecutionBinding.bindingRevision, botExecutionDirectory.bindingRevision),
                ),
            )
            .innerJoin(
                pairingChannel,
                and(
                    eq(pairingChannel.projectId, bot.projectId),
                    eq(pairingChannel.runtimeId, botExecutionDirectory.runtimeId),
                ),
            )
            .where(
                and(
                    eq(botExecutionDirectory.executionId, executionId),
                    eq(pairingChannel.daemonTokenHash, digest),
                    eq(pairingChannel.status, "paired"),
                    eq(botExecutionBinding.lifecycle, "approved"),
                    isNotNull(botExecutionBinding.localGrantId),
                ),
            )
            .limit(1);
        if (row === undefined) {
            return null;
        }
        if (row.local_grant_id === null) {
            throw new Error("Approved Bot execution binding has no local grant");
        }
        return { ...row, local_grant_id: row.local_grant_id };
    };
}
