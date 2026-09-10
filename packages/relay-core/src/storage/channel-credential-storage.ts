import type { SqlDatabase } from "../infra/sql-database.ts";

export interface ChannelCredentialIdentity {
    readonly channelId: string;
    readonly credentialId: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly tenantId: string;
}

export class ChannelCredentialStorage {
    readonly #database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly readActive = (identity: ChannelCredentialIdentity, signal: AbortSignal) =>
        this.#database
            .prepare(`SELECT 1 AS active FROM pairing_channels AS channels
            WHERE channels.channel_id = ? AND channels.runtime_id = ?
                AND channels.tenant_id = ? AND channels.project_id = ? AND channels.status = 'paired'
                AND (
                    EXISTS (
                        SELECT 1 FROM channel_host_credentials AS credentials
                        WHERE credentials.credential_id = ? AND credentials.channel_id = channels.channel_id
                            AND credentials.revoked_at IS NULL
                    )
                    OR EXISTS (
                        SELECT 1 FROM project_owner_credentials AS owners
                        WHERE owners.credential_id = ? AND owners.tenant_id = channels.tenant_id
                            AND owners.project_id = channels.project_id AND owners.revoked_at IS NULL
                    )
                )`)
            .bind(
                identity.channelId,
                identity.runtimeId,
                identity.tenantId,
                identity.projectId,
                identity.credentialId,
                identity.credentialId,
            )
            .first<{ readonly active: number }>(signal);
}
