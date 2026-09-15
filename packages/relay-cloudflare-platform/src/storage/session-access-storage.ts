import * as v from "valibot";
import { type SessionAccessRecord, sessionAccessRecordSchema } from "../entity/session-access-record.ts";
import { waitForD1 } from "./d1-operation.ts";
import { PlatformControlPlaneStorage } from "./platform-control-plane-storage.ts";
import { type PlatformDatabaseBinding, projectDatabase } from "./platform-database-resolver.ts";
import { PlatformProjectAuthorizationStorage } from "./platform-project-authorization-storage.ts";

export class SessionAccessStorage {
    private readonly shards: readonly PlatformDatabaseBinding[];
    private readonly control: PlatformControlPlaneStorage;
    private readonly projects: PlatformProjectAuthorizationStorage;
    constructor(database: D1Database, shards: readonly PlatformDatabaseBinding[]) {
        this.shards = shards;
        this.control = new PlatformControlPlaneStorage(database, shards);
        this.projects = new PlatformProjectAuthorizationStorage(shards);
    }

    readonly insert = async (row: SessionAccessRecord, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const database = projectDatabase(this.shards, row.project_id);
        await waitForD1(
            () =>
                database.batch([
                    database
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
                    database
                        .prepare(`INSERT INTO platform_audit_events
                (audit_id, tenant_id, app_id, project_id, actor_kind, actor_id, actor_ref, action, subject_id, outcome, details_json, recorded_at)
                SELECT ?, p.tenant_id, p.app_id, p.project_id, 'application', ?, '', 'session_access.issued', ?, 'succeeded', ?, ?
                FROM platform_project_authorizations p WHERE p.project_id = ?`)
                        .bind(
                            `saa_${row.credential_id}`,
                            row.parent_credential_id,
                            row.session_id,
                            JSON.stringify({ credentialId: row.credential_id, expiresAt: row.expires_at }),
                            Date.now(),
                            row.project_id,
                        ),
                ]),
            signal,
        );
        signal.throwIfAborted();
    };

    readonly readActive = async (
        projectId: string,
        id: string,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionAccessRecord | null> => {
        signal.throwIfAborted();
        const value: unknown = await waitForD1(
            () =>
                projectDatabase(this.shards, projectId)
                    .prepare(`SELECT s.* FROM session_access_credentials s
            WHERE s.credential_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
              AND s.project_id = ?
            `)
                    .bind(id, now, projectId)
                    .first(),
            signal,
        );
        signal.throwIfAborted();
        if (value === null) {
            return null;
        }
        const row = v.parse(sessionAccessRecordSchema, value);
        const parent = await this.control.readCredentialById(row.parent_credential_id, signal);
        const project = await this.projects.read(projectId, signal);
        if (
            parent === null ||
            project === null ||
            project.lifecycle !== "active" ||
            project.app_id !== parent.app_id ||
            project.tenant_id !== parent.tenant_id ||
            parent.app_lifecycle !== "active" ||
            parent.tenant_lifecycle !== "active" ||
            parent.revoked_at !== null ||
            parent.revision !== row.parent_revision ||
            (parent.replaced_by_credential_id !== null &&
                (parent.overlap_ends_at === null || parent.overlap_ends_at <= now)) ||
            (parent.all_projects !== 1 &&
                !(await this.control.credentialHasProject(parent.credential_id, projectId, signal)))
        ) {
            return null;
        }
        const permissions = v.parse(v.array(v.string()), JSON.parse(parent.permissions_json));
        return [
            "session:read",
            "session:write",
            "conversation:turn:create",
            "conversation:turn:cancel",
            "project:event:read",
        ].every((permission) => permissions.includes(permission))
            ? row
            : null;
    };
}
