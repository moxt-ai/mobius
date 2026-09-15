import { type OrganizationInviteRow, organizationInviteRowSchema } from "../entity/organization-invite.ts";
import { decodeOptionalStorageRecord, decodeStorageRecords } from "./decode-storage-record.ts";

export class OrganizationInviteStorage {
    private readonly database: D1Database;
    constructor(database: D1Database) {
        this.database = database;
    }

    private readonly audit = (organizationId: string, actor: string, id: string, action: string, now: number) =>
        this.database
            .prepare(`INSERT INTO platform_audit_events
            (audit_id, tenant_id, app_id, project_id, actor_kind, actor_id, actor_ref, action, subject_id, outcome, details_json, recorded_at)
            VALUES (?, ?, '', '', 'developer', ?, '', ?, ?, 'succeeded', '{}', ?)`)
            .bind(crypto.randomUUID(), organizationId, actor, action, id, now);

    readonly create = async (row: OrganizationInviteRow, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        await this.database.batch([
            this.database
                .prepare(`INSERT INTO platform_organization_invite_links
                (id, organization_id, token_hash, creator_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
                .bind(row.id, row.organization_id, row.token_hash, row.creator_id, row.created_at, row.expires_at),
            this.audit(row.organization_id, row.creator_id, row.id, "organization_invite.created", row.created_at),
        ]);
        signal.throwIfAborted();
    };

    readonly list = async (id: string, now: number, signal: AbortSignal): Promise<readonly OrganizationInviteRow[]> => {
        signal.throwIfAborted();
        const rows = await this.database
            .prepare(
                "SELECT * FROM platform_organization_invite_links WHERE organization_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 100",
            )
            .bind(id, now)
            .all();
        signal.throwIfAborted();
        return decodeStorageRecords(organizationInviteRowSchema, rows.results);
    };

    readonly find = async (hash: string, signal: AbortSignal): Promise<OrganizationInviteRow | null> => {
        signal.throwIfAborted();
        const row = await this.database
            .prepare("SELECT * FROM platform_organization_invite_links WHERE token_hash = ?")
            .bind(hash)
            .first();
        signal.throwIfAborted();
        return decodeOptionalStorageRecord(organizationInviteRowSchema, row);
    };

    readonly revoke = async (
        organizationId: string,
        id: string,
        actor: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await this.database.batch([
            this.database
                .prepare(
                    "UPDATE platform_organization_invite_links SET revoked_at = COALESCE(revoked_at, ?) WHERE organization_id = ? AND id = ?",
                )
                .bind(now, organizationId, id),
            this.audit(organizationId, actor, id, "organization_invite.revoked", now),
        ]);
        signal.throwIfAborted();
    };

    readonly accepted = async (
        row: OrganizationInviteRow,
        actor: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        await this.audit(row.organization_id, actor, row.id, "organization_invite.accepted", now).run();
        signal.throwIfAborted();
    };
}
