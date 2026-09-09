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
            .prepare(`SELECT 1 AS active FROM channel_host_credentials AS credentials
            INNER JOIN pairing_channels AS channels ON channels.channel_id = credentials.channel_id
            WHERE credentials.credential_id = ? AND credentials.channel_id = ?
                AND credentials.revoked_at IS NULL AND channels.runtime_id = ?
                AND channels.tenant_id = ? AND channels.project_id = ? AND channels.status = 'paired'`)
            .bind(identity.credentialId, identity.channelId, identity.runtimeId, identity.tenantId, identity.projectId)
            .first<{ readonly active: number }>(signal);
}
