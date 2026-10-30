import { and, desc, eq, exists, gt, isNull, sql } from "drizzle-orm";
import type { AuthorizedChannelRow, LinkedDeviceRow } from "../entity/pairing/pairing-records.ts";
import { relayDrizzle } from "../infra/drizzle-database.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";
import { channelAccessGrant, channelHostCredential, runtimeIdentity } from "../schema/project-do/index.ts";
import { hostCredentialValid } from "./host-credential-validity.ts";

/** Host, access grant and browser credentials in the Project's own storage. */
export class PairingStorage {
    readonly #database: SqlDatabase;
    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly readHost = async (
        channelId: string,
        tokenHash: string,
        signal: AbortSignal,
    ): Promise<AuthorizedChannelRow | null> => {
        const database = relayDrizzle(this.#database, signal);
        const rows = await database
            .select({
                channel_id: runtimeIdentity.channelId,
                runtime_id: runtimeIdentity.runtimeId,
                project_id: runtimeIdentity.projectId,
                credential_id: channelHostCredential.credentialId,
                authority: channelHostCredential.authority,
            })
            .from(channelHostCredential)
            .innerJoin(runtimeIdentity, eq(runtimeIdentity.channelId, channelHostCredential.channelId))
            .where(
                and(
                    eq(channelHostCredential.channelId, channelId),
                    eq(channelHostCredential.tokenHash, tokenHash),
                    hostCredentialValid(database),
                ),
            )
            .limit(1);
        return rows[0] ?? null;
    };

    /** Records use of a host credential; false when it no longer authenticates. */
    readonly touchHost = async (credentialId: string, now: number, signal: AbortSignal): Promise<boolean> => {
        const database = relayDrizzle(this.#database, signal);
        const touched = await database
            .update(channelHostCredential)
            .set({ lastUsedAt: now })
            .where(and(eq(channelHostCredential.credentialId, credentialId), hostCredentialValid(database)))
            .returning({ credentialId: channelHostCredential.credentialId });
        return touched.length === 1;
    };

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

    readonly listLinked = async (channelId: string, signal: AbortSignal): Promise<readonly LinkedDeviceRow[]> => {
        const database = relayDrizzle(this.#database, signal);
        return await database
            .select({
                credential_id: channelHostCredential.credentialId,
                created_at: channelHostCredential.createdAt,
                last_used_at: channelHostCredential.lastUsedAt,
            })
            .from(channelHostCredential)
            .where(
                and(
                    eq(channelHostCredential.channelId, channelId),
                    eq(channelHostCredential.authority, "linked"),
                    hostCredentialValid(database),
                ),
            )
            .orderBy(desc(channelHostCredential.createdAt), desc(channelHostCredential.credentialId));
    };

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
