import * as v from "valibot";
import { type SessionAccessRecord, sessionAccessRecordSchema } from "../entity/session-access-record.ts";

export class SessionAccessStorage {
    private readonly database: D1Database;
    constructor(database: D1Database) {
        this.database = database;
    }

    readonly insert = async (row: SessionAccessRecord, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        await this.database.batch([
            this.database
                .prepare(`INSERT INTO session_access_credentials
            (credential_id, secret_digest, project_id, session_id, parent_credential_id, parent_revision, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .bind(
                    row.credential_id,
                    row.secret_digest,
                    row.project_id,
                    row.session_id,
                    row.parent_credential_id,
                    row.parent_revision,
                    row.expires_at,
                ),
            this.database
                .prepare(`INSERT INTO platform_audit_events
                (audit_id, tenant_id, app_id, project_id, actor_kind, actor_id, actor_ref, action, subject_id, outcome, details_json, recorded_at)
                SELECT ?, p.tenant_id, p.app_id, p.project_id, 'application', ?, '', 'session_access.issued', ?, 'succeeded', ?, ?
                FROM platform_projects p WHERE p.project_id = ?`)
                .bind(
                    `saa_${row.credential_id}`,
                    row.parent_credential_id,
                    row.session_id,
                    JSON.stringify({ credentialId: row.credential_id, expiresAt: row.expires_at }),
                    Date.now(),
                    row.project_id,
                ),
        ]);
        signal.throwIfAborted();
    };

    readonly readActive = async (id: string, now: number, signal: AbortSignal): Promise<SessionAccessRecord | null> => {
        signal.throwIfAborted();
        const value: unknown = await this.database
            .prepare(`SELECT s.* FROM session_access_credentials s
            JOIN platform_app_credentials c ON c.credential_id = s.parent_credential_id
            JOIN platform_projects p ON p.project_id = s.project_id AND p.app_id = c.app_id
            JOIN platform_apps a ON a.app_id = p.app_id
            JOIN platform_tenants t ON t.tenant_id = a.tenant_id
            WHERE s.credential_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
              AND c.revoked_at IS NULL AND c.expires_at > ? AND c.revision = s.parent_revision
              AND (c.replaced_by_credential_id IS NULL OR c.overlap_ends_at > ?)
              AND p.lifecycle = 'active' AND a.lifecycle = 'active' AND t.lifecycle = 'active'
              AND (c.all_projects = 1 OR EXISTS (SELECT 1 FROM platform_app_credential_projects cp
                   WHERE cp.credential_id = c.credential_id AND cp.project_id = p.project_id))
              AND EXISTS (SELECT 1 FROM json_each(c.permissions_json) WHERE value = 'session:read')
              AND EXISTS (SELECT 1 FROM json_each(c.permissions_json) WHERE value = 'session:write')
              AND EXISTS (SELECT 1 FROM json_each(c.permissions_json) WHERE value = 'conversation:turn:create')
              AND EXISTS (SELECT 1 FROM json_each(c.permissions_json) WHERE value = 'conversation:turn:cancel')
              AND EXISTS (SELECT 1 FROM json_each(c.permissions_json) WHERE value = 'project:event:read')
            `)
            .bind(id, now, now, now)
            .first();
        signal.throwIfAborted();
        return value === null ? null : v.parse(sessionAccessRecordSchema, value);
    };
}
