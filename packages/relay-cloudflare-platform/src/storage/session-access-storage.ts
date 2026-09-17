import { relayDrizzle } from "@moxt-ai/mobius-relay-core/database";
import { platformProjectAuthorization } from "@moxt-ai/mobius-relay-core/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import * as v from "valibot";
import { type SessionAccessRecord, sessionAccessRecordSchema } from "../entity/session-access-record.ts";
import { platformAuditEvent, sessionAccessCredential } from "../schema/index.ts";
import { waitForD1 } from "./d1-operation.ts";
import { PlatformControlPlaneStorage } from "./platform-control-plane-storage.ts";
import { type PlatformDatabaseResolver, projectSqlDatabase } from "./platform-database-resolver.ts";
import { PlatformProjectAuthorizationStorage } from "./platform-project-authorization-storage.ts";

export class SessionAccessStorage {
    private readonly databases: PlatformDatabaseResolver;
    private readonly control: PlatformControlPlaneStorage;
    private readonly projects: PlatformProjectAuthorizationStorage;
    constructor(database: D1Database, databases: PlatformDatabaseResolver) {
        this.databases = databases;
        this.control = new PlatformControlPlaneStorage(database, databases);
        this.projects = new PlatformProjectAuthorizationStorage(databases);
    }

    readonly insert = async (row: SessionAccessRecord, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        const database = relayDrizzle(projectSqlDatabase(this.databases, row.project_id), signal);
        const [project] = await waitForD1(
            () =>
                database
                    .select({
                        tenantId: platformProjectAuthorization.tenantId,
                        appId: platformProjectAuthorization.appId,
                    })
                    .from(platformProjectAuthorization)
                    .where(eq(platformProjectAuthorization.projectId, row.project_id))
                    .limit(1),
            signal,
        );
        if (project === undefined) {
            return;
        }
        await waitForD1(
            () =>
                database.batch([
                    database.insert(sessionAccessCredential).values({
                        credentialId: row.credential_id,
                        secretDigest: row.secret_digest,
                        projectId: row.project_id,
                        sessionId: row.session_id,
                        parentCredentialId: row.parent_credential_id,
                        parentRevision: row.parent_revision,
                        expiresAt: row.expires_at,
                    }),
                    database.insert(platformAuditEvent).values({
                        auditId: `saa_${row.credential_id}`,
                        tenantId: project.tenantId,
                        appId: project.appId,
                        projectId: row.project_id,
                        actorKind: "application",
                        actorId: row.parent_credential_id,
                        actorRef: "",
                        action: "session_access.issued",
                        subjectId: row.session_id,
                        outcome: "succeeded",
                        detailsJson: JSON.stringify({ credentialId: row.credential_id, expiresAt: row.expires_at }),
                        recordedAt: Date.now(),
                    }),
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
                relayDrizzle(projectSqlDatabase(this.databases, projectId), signal)
                    .select({
                        credential_id: sessionAccessCredential.credentialId,
                        secret_digest: sessionAccessCredential.secretDigest,
                        project_id: sessionAccessCredential.projectId,
                        session_id: sessionAccessCredential.sessionId,
                        parent_credential_id: sessionAccessCredential.parentCredentialId,
                        parent_revision: sessionAccessCredential.parentRevision,
                        expires_at: sessionAccessCredential.expiresAt,
                        revoked_at: sessionAccessCredential.revokedAt,
                    })
                    .from(sessionAccessCredential)
                    .where(
                        and(
                            eq(sessionAccessCredential.credentialId, id),
                            isNull(sessionAccessCredential.revokedAt),
                            gt(sessionAccessCredential.expiresAt, now),
                            eq(sessionAccessCredential.projectId, projectId),
                        ),
                    )
                    .limit(1)
                    .then((rows) => rows[0] ?? null),
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
