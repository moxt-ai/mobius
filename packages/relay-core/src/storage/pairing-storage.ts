import { and, eq, exists, gt, isNull, sql } from "drizzle-orm";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { ProjectStorageContext } from "../infra/project-storage-directory.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { channelAccessGrant, channelHostCredential, runtimeIdentity } from "../schema/project-do/index.ts";
import { RuntimeDirectoryStorage } from "./runtime-directory-storage.ts";

interface ChannelScopeRow {
    readonly channel_id: string;
    readonly project_id: string;
    readonly runtime_id: string;
}
export interface AuthorizedChannelRow extends ChannelScopeRow {
    readonly credential_id: string;
    readonly authority: string;
}
interface BrowserCredentialRow {
    readonly credential_id: string;
    readonly expires_at: number;
    readonly project_id: string;
    readonly revoked_at: unknown;
}

export class PairingStorage {
    readonly #database: SqlDatabase;
    readonly runtimes: RuntimeDirectoryStorage;
    constructor(project: ProjectStorageContext, databases: DatabaseResolver) {
        this.#database = databases.resolve(project.storagePlacement);
        this.runtimes = new RuntimeDirectoryStorage(project.projectId, this.#database);
    }

    readonly readHost = (channelId: string, tokenHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT channels.channel_id, channels.runtime_id, channels.project_id,
            credentials.credential_id, credentials.authority
        FROM runtimes AS channels
        INNER JOIN runtime_registrations AS registrations ON registrations.runtime_id = channels.runtime_id
        INNER JOIN channel_host_credentials AS credentials
            ON credentials.channel_id = channels.channel_id
        WHERE channels.channel_id = ? AND credentials.token_hash = ?
            AND credentials.revoked_at IS NULL AND channels.revoked_at IS NULL
            AND (credentials.replaced_by_credential_id IS NULL OR credentials.overlap_ends_at > ?)`)
            .bind(channelId, tokenHash, Date.now())
            .first<AuthorizedChannelRow>(signal);

    readonly readProjectHost = (projectId: string, tokenHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT channels.channel_id, channels.runtime_id, channels.project_id,
            credentials.credential_id, credentials.authority
        FROM runtimes AS channels
        INNER JOIN runtime_registrations AS registrations ON registrations.runtime_id = channels.runtime_id
        INNER JOIN channel_host_credentials AS credentials
            ON credentials.channel_id = channels.channel_id
        WHERE channels.project_id = ? AND credentials.token_hash = ?
            AND credentials.revoked_at IS NULL AND channels.revoked_at IS NULL`)
            .bind(projectId, tokenHash)
            .first<AuthorizedChannelRow>(signal);

    readonly readRuntimeHost = (projectId: string, runtimeId: string, tokenHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT channels.channel_id, channels.runtime_id, channels.project_id,
            credentials.credential_id, credentials.authority
        FROM runtimes AS channels
        INNER JOIN runtime_registrations AS registrations ON registrations.runtime_id = channels.runtime_id
        INNER JOIN channel_host_credentials AS credentials
            ON credentials.channel_id = channels.channel_id
        WHERE channels.project_id = ? AND channels.runtime_id = ? AND credentials.token_hash = ?
            AND credentials.revoked_at IS NULL AND channels.revoked_at IS NULL`)
            .bind(projectId, runtimeId, tokenHash)
            .first<AuthorizedChannelRow>(signal);

    readonly touchHost = (credentialId: string, now: number, signal: AbortSignal) =>
        this.#database
            .prepare(`
        UPDATE channel_host_credentials SET last_used_at = ? WHERE credential_id = ? AND revoked_at IS NULL
            AND (replaced_by_credential_id IS NULL OR overlap_ends_at > ?)`)
            .bind(now, credentialId, now)
            .run(signal);

    readonly readBrowser = (projectId: string, tokenHash: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT credential_id, project_id, expires_at, revoked_at FROM project_browser_credentials
        WHERE project_id = ? AND token_hash = ?`)
            .bind(projectId, tokenHash)
            .first<BrowserCredentialRow>(signal);

    readonly touchBrowser = (credentialId: string, now: number, signal: AbortSignal) =>
        this.#database
            .prepare(`
        UPDATE project_browser_credentials SET last_used_at = ?
        WHERE credential_id = ? AND revoked_at IS NULL AND expires_at > ?`)
            .bind(now, credentialId, now)
            .run(signal);

    readonly createGrant = (
        grantId: string,
        channelId: string,
        secretHash: string,
        credentialId: string,
        now: number,
        expiresAt: number,
        signal: AbortSignal,
    ) =>
        this.#database
            .prepare(`
        INSERT INTO channel_access_grants (grant_id, channel_id, secret_hash, created_by_credential_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(grantId, channelId, secretHash, credentialId, now, expiresAt)
            .run(signal);

    readonly createBrowser = (
        credentialId: string,
        projectId: string,
        tokenHash: string,
        ownerId: string,
        now: number,
        expiresAt: number,
        signal: AbortSignal,
    ) =>
        this.#database
            .prepare(`
        INSERT INTO project_browser_credentials (credential_id, project_id, token_hash,
            created_by_credential_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .bind(credentialId, projectId, tokenHash, ownerId, now, expiresAt, now)
            .run(signal);

    readonly listLinked = (channelId: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT credential_id, created_at, last_used_at FROM channel_host_credentials
        WHERE channel_id = ? AND authority = 'linked' AND revoked_at IS NULL ORDER BY created_at DESC, credential_id DESC`)
            .bind(channelId)
            .all<{ readonly credential_id: string; readonly created_at: number; readonly last_used_at: number }>(
                signal,
            );

    readonly createProjectControlHost = (
        projectId: string,
        runtimeId: string,
        credentialId: string,
        tokenHash: string,
        now: number,
        signal: AbortSignal,
    ) =>
        this.#database
            .prepare(`INSERT INTO channel_host_credentials
                (credential_id, channel_id, token_hash, authority, created_at, last_used_at)
                SELECT ?, runtimes.channel_id, ?, 'linked', ?, ? FROM runtimes
                 INNER JOIN runtime_registrations AS registrations ON registrations.runtime_id = runtimes.runtime_id
                 WHERE runtimes.project_id = ? AND runtimes.runtime_id = ? AND runtimes.revoked_at IS NULL
                RETURNING channel_id`)
            .bind(credentialId, tokenHash, now, now, projectId, runtimeId)
            .first<{ readonly channel_id: string }>(signal);

    readonly removeControlHost = (channelId: string, credentialId: string, signal: AbortSignal) =>
        this.#database
            .prepare(
                `DELETE FROM channel_host_credentials WHERE channel_id = ? AND credential_id = ? AND source_grant_id IS NULL AND authority = 'linked'`,
            )
            .bind(channelId, credentialId)
            .run(signal);

    readonly removeProjectControlHost = (projectId: string, credentialId: string, signal: AbortSignal) =>
        this.#database
            .prepare(
                `DELETE FROM channel_host_credentials
                  WHERE credential_id = ? AND source_grant_id IS NULL AND authority = 'linked'
                    AND EXISTS (
                        SELECT 1 FROM runtimes
                         WHERE runtimes.channel_id = channel_host_credentials.channel_id
                           AND runtimes.project_id = ?
                    )`,
            )
            .bind(credentialId, projectId)
            .run(signal);

    readonly redeemGrant = (
        channelId: string,
        grantId: string,
        secretHash: string,
        credentialId: string,
        hostHash: string,
        now: number,
        signal: AbortSignal,
    ) => {
        const database = relayDrizzle(this.#database, signal);
        const grant = and(eq(channelAccessGrant.grantId, grantId), eq(channelAccessGrant.channelId, channelId));
        const redemption = database
            .update(channelAccessGrant)
            .set({ redeemedAt: now, redeemedCredentialId: credentialId })
            .where(
                and(
                    grant,
                    eq(channelAccessGrant.secretHash, secretHash),
                    isNull(channelAccessGrant.redeemedAt),
                    gt(channelAccessGrant.expiresAt, now),
                    exists(
                        database
                            .select({ runtimeId: runtimeIdentity.runtimeId })
                            .from(runtimeIdentity)
                            .where(
                                and(
                                    eq(runtimeIdentity.channelId, channelAccessGrant.channelId),
                                    isNull(runtimeIdentity.revokedAt),
                                ),
                            ),
                    ),
                ),
            );
        const credential = database.insert(channelHostCredential).select(
            database
                .select({
                    credentialId: sql<string>`${credentialId}`.as("credential_id"),
                    channelId: channelAccessGrant.channelId,
                    tokenHash: sql<string>`${hostHash}`.as("token_hash"),
                    authority: sql<"linked">`'linked'`.as("authority"),
                    createdAt: sql<number>`${now}`.as("created_at"),
                    lastUsedAt: sql<number>`${now}`.as("last_used_at"),
                    revokedAt: sql<null>`null`.as("revoked_at"),
                    sourceGrantId: channelAccessGrant.grantId,
                    replacedByCredentialId: sql<null>`null`.as("replaced_by_credential_id"),
                    overlapEndsAt: sql<null>`null`.as("overlap_ends_at"),
                })
                .from(channelAccessGrant)
                .where(
                    and(
                        grant,
                        eq(channelAccessGrant.redeemedAt, now),
                        eq(channelAccessGrant.redeemedCredentialId, credentialId),
                    ),
                ),
        );
        // Authorization and consumption share the credential-issuance transaction.
        return this.#database.batch(
            [redemption, credential].map((query) => {
                const { sql, params } = query.toSQL();
                return this.#database.prepare(sql).bind(...params);
            }),
            signal,
        );
    };

    readonly readGrant = async (channelId: string, grantId: string, secretHash: string, signal: AbortSignal) => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({
                expires_at: channelAccessGrant.expiresAt,
                redeemed_at: channelAccessGrant.redeemedAt,
                runtime_revoked_at: runtimeIdentity.revokedAt,
            })
            .from(channelAccessGrant)
            .innerJoin(runtimeIdentity, eq(runtimeIdentity.channelId, channelAccessGrant.channelId))
            .where(
                and(
                    eq(channelAccessGrant.grantId, grantId),
                    eq(channelAccessGrant.channelId, channelId),
                    eq(channelAccessGrant.secretHash, secretHash),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    readonly revokeLinked = (channelId: string, credentialId: string, now: number, signal: AbortSignal) =>
        this.#database
            .prepare(`
        UPDATE channel_host_credentials SET revoked_at = ? WHERE credential_id = ? AND channel_id = ?
            AND authority = 'linked' AND revoked_at IS NULL`)
            .bind(now, credentialId, channelId)
            .run(signal);

    readonly readLinked = (channelId: string, credentialId: string, signal: AbortSignal) =>
        this.#database
            .prepare(`
        SELECT credential_id FROM channel_host_credentials WHERE credential_id = ? AND channel_id = ? AND authority = 'linked'`)
            .bind(credentialId, channelId)
            .first<{ readonly credential_id: string }>(signal);

    readonly revokeBrowser = (projectId: string, credentialId: string, now: number, signal: AbortSignal) =>
        this.#database
            .prepare(`
        UPDATE project_browser_credentials SET revoked_at = COALESCE(revoked_at, ?)
        WHERE credential_id = ? AND project_id = ?`)
            .bind(now, credentialId, projectId)
            .run(signal);
}
