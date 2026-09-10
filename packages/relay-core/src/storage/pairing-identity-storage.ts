import { validateIdentifier } from "../entity/pairing/pairing.ts";
import type { PairingIdentityCredential } from "../entity/pairing/pairing-identity.ts";
import type { DatabaseResolver } from "../infra/database-resolver.ts";
import type { SqlDatabase, SqlStatement } from "../infra/sql-database.ts";
import type { TenantContext } from "../infra/tenant-sharding-directory.ts";

export interface IdentityDatabaseSource {
    readonly sourceId: string;
    readonly database: SqlDatabase;
}

function identityStatement(database: SqlDatabase, credential: PairingIdentityCredential): SqlStatement {
    switch (credential.kind) {
        case "host":
            return database
                .prepare(`SELECT DISTINCT channels.tenant_id FROM pairing_channels AS channels
                INNER JOIN channel_host_credentials AS credentials ON credentials.channel_id = channels.channel_id
                WHERE channels.channel_id = ? AND credentials.token_hash = ?
                AND credentials.revoked_at IS NULL AND channels.status = 'paired'
                AND (credentials.replaced_by_credential_id IS NULL OR credentials.overlap_ends_at > ?)`)
                .bind(validateIdentifier(credential.channelId, "channel_id"), credential.tokenHash, Date.now());
        case "daemon":
            return database
                .prepare(`SELECT tenant_id FROM pairing_channels
                WHERE channel_id = ? AND daemon_token_hash = ? AND status = 'paired'`)
                .bind(validateIdentifier(credential.channelId, "channel_id"), credential.tokenHash);
        case "project":
            return database
                .prepare(`SELECT tenant_id, NULL AS expires_at, revoked_at FROM project_owner_credentials
                WHERE project_id = ? AND token_hash = ?
                UNION SELECT DISTINCT channels.tenant_id, NULL AS expires_at, NULL AS revoked_at FROM pairing_channels AS channels
                INNER JOIN channel_host_credentials AS credentials ON credentials.channel_id = channels.channel_id
                WHERE channels.project_id = ? AND credentials.token_hash = ?
                AND credentials.revoked_at IS NULL AND channels.status = 'paired'
                UNION SELECT tenant_id, expires_at, revoked_at FROM project_browser_credentials WHERE project_id = ? AND token_hash = ?`)
                .bind(
                    validateIdentifier(credential.projectId, "project_id"),
                    credential.tokenHash,
                    credential.projectId,
                    credential.tokenHash,
                    credential.projectId,
                    credential.tokenHash,
                );
        case "pairing":
            return database
                .prepare("SELECT tenant_id FROM pairing_channels WHERE pairing_id = ? AND poll_token_hash = ?")
                .bind(validateIdentifier(credential.pairingId, "pairing_id"), credential.tokenHash);
        case "pairing-code":
            return database
                .prepare("SELECT tenant_id FROM pairing_channels WHERE pairing_code_hash = ?")
                .bind(credential.codeHash);
        case "grant":
            return database
                .prepare(`SELECT channels.tenant_id FROM channel_access_grants AS grants
                INNER JOIN pairing_channels AS channels ON channels.channel_id = grants.channel_id
                WHERE grants.channel_id = ? AND grants.grant_id = ? AND grants.secret_hash = ?`)
                .bind(
                    validateIdentifier(credential.channelId, "channel_id"),
                    validateIdentifier(credential.grantId, "grant_id"),
                    credential.secretHash,
                );
    }
}

export class PairingIdentityStorage {
    readonly #sources: readonly IdentityDatabaseSource[];
    readonly #databases: DatabaseResolver;
    constructor(sources: readonly IdentityDatabaseSource[], databases: DatabaseResolver) {
        this.#sources = [...sources];
        this.#databases = databases;
    }

    readonly matchesPlacement = (sourceId: string, tenant: TenantContext): boolean => {
        const source = this.#sources.find((candidate) => candidate.sourceId === sourceId);
        return source !== undefined && source.database === this.#databases.resolve(tenant.tenantSharding);
    };

    readonly find = async (credential: PairingIdentityCredential, signal: AbortSignal) => {
        const matches: { readonly sourceId: string; readonly row: Readonly<Record<string, unknown>> }[] = [];
        for (const source of this.#sources) {
            const rows = await identityStatement(source.database, credential).all<Readonly<Record<string, unknown>>>(
                signal,
            );
            for (const row of rows.results) {
                matches.push({ sourceId: source.sourceId, row });
            }
        }
        return matches;
    };

    readonly findRuntime = async (tokenHash: string, signal: AbortSignal) => {
        const matches: { readonly sourceId: string; readonly row: Readonly<Record<string, unknown>> }[] = [];
        for (const source of this.#sources) {
            const rows = await source.database
                .prepare(`SELECT tenant_id, project_id, runtime_id, channel_id, pairing_id
                    FROM pairing_channels
                    WHERE daemon_token_hash = ? AND status = 'paired'`)
                .bind(tokenHash)
                .all<Readonly<Record<string, unknown>>>(signal);
            for (const row of rows.results) {
                matches.push({ sourceId: source.sourceId, row });
            }
        }
        return matches;
    };
}
