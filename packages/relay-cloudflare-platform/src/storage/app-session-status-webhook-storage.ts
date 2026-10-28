import { and, eq, sql } from "drizzle-orm";
import type { StoredAppSessionStatusWebhook } from "../entity/app-session-status-webhook.ts";
import type { PlatformAuditRecord } from "../entity/platform-records.ts";
import { platformAppSessionStatusWebhook, platformDashboardAuditEvent, platformProject } from "../schema/d1/index.ts";
import { platformDrizzle } from "./platform-drizzle-database.ts";

export class AppSessionStatusWebhookStorage {
    readonly #database;

    constructor(database: D1Database) {
        this.#database = platformDrizzle(database);
    }

    readonly read = async (appId: string): Promise<StoredAppSessionStatusWebhook | null> => {
        const rows = await this.#database
            .select({ webhook: platformAppSessionStatusWebhook })
            .from(platformProject)
            .innerJoin(
                platformAppSessionStatusWebhook,
                eq(platformAppSessionStatusWebhook.appId, platformProject.appId),
            )
            .where(eq(platformProject.projectId, appId))
            .limit(1);
        const joined = rows[0]?.webhook;
        if (joined !== undefined) {
            return decode(joined);
        }
        const row = await this.#database
            .select()
            .from(platformAppSessionStatusWebhook)
            .where(eq(platformAppSessionStatusWebhook.appId, appId))
            .limit(1);
        return row[0] === undefined ? null : decode(row[0]);
    };

    /** Stores the first webhook for an App. Null means another request already created it. */
    readonly create = async (
        value: StoredAppSessionStatusWebhook,
        now: number,
        audit: PlatformAuditRecord,
    ): Promise<StoredAppSessionStatusWebhook | null> => {
        const [result] = await this.#database.batch([
            this.#database
                .insert(platformAppSessionStatusWebhook)
                .values({
                    appId: value.appId,
                    enabled: value.enabled ? 1 : 0,
                    endpoint: value.endpoint,
                    secretCiphertext: value.secretCiphertext,
                    secretId: value.secretId,
                    secretNonce: value.secretNonce,
                    createdAt: now,
                    updatedAt: now,
                })
                .onConflictDoNothing({ target: platformAppSessionStatusWebhook.appId })
                .returning(),
            this.#auditWhere(audit, value.appId, value.secretId),
        ]);
        return result[0] === undefined ? null : decode(result[0]);
    };

    /** Changes delivery settings only; the signing secret belongs to creation and rotation. */
    readonly updateSettings = async (
        appId: string,
        enabled: boolean,
        endpoint: string,
        now: number,
        audit: PlatformAuditRecord,
    ): Promise<StoredAppSessionStatusWebhook | null> => {
        const [result] = await this.#database.batch([
            this.#database
                .update(platformAppSessionStatusWebhook)
                .set({ enabled: enabled ? 1 : 0, endpoint, updatedAt: now })
                .where(eq(platformAppSessionStatusWebhook.appId, appId))
                .returning(),
            this.#auditWhere(audit, appId, null),
        ]);
        return result[0] === undefined ? null : decode(result[0]);
    };

    /** Replaces the secret only if it is still the one the caller read. Null means another rotation won. */
    readonly rotateSecret = async (
        appId: string,
        previousSecretId: string,
        secret: Pick<StoredAppSessionStatusWebhook, "secretCiphertext" | "secretId" | "secretNonce">,
        now: number,
        audit: PlatformAuditRecord,
    ): Promise<StoredAppSessionStatusWebhook | null> => {
        const [result] = await this.#database.batch([
            this.#database
                .update(platformAppSessionStatusWebhook)
                .set({ ...secret, updatedAt: now })
                .where(
                    and(
                        eq(platformAppSessionStatusWebhook.appId, appId),
                        eq(platformAppSessionStatusWebhook.secretId, previousSecretId),
                    ),
                )
                .returning(),
            this.#auditWhere(audit, appId, secret.secretId),
        ]);
        return result[0] === undefined ? null : decode(result[0]);
    };

    /**
     * The audit event commits with the change it records and exists only if that change took effect: the webhook
     * row exists, and when a secret was written, it holds that secret.
     */
    readonly #auditWhere = (audit: PlatformAuditRecord, appId: string, secretId: string | null) =>
        this.#database.insert(platformDashboardAuditEvent).select(
            this.#database
                .select({
                    auditId: sql<string>`${audit.auditId}`.as("auditId"),
                    tenantId: sql<string>`${audit.tenantId}`.as("tenantId"),
                    appId: sql<string>`${audit.appId}`.as("appId"),
                    projectId: sql<string>`${audit.projectId}`.as("projectId"),
                    actorKind: sql<string>`${audit.actorKind}`.as("actorKind"),
                    actorId: sql<string>`${audit.actorId}`.as("actorId"),
                    actorRef: sql<string>`${audit.actorRef}`.as("actorRef"),
                    action: sql<string>`${audit.action}`.as("action"),
                    subjectId: sql<string>`${audit.subjectId}`.as("subjectId"),
                    outcome: sql<"succeeded" | "denied">`${audit.outcome}`.as("outcome"),
                    detailsJson: sql<string>`${audit.detailsJson}`.as("detailsJson"),
                    recordedAt: sql<number>`${audit.recordedAt}`.as("recordedAt"),
                })
                .from(platformAppSessionStatusWebhook)
                .where(
                    secretId === null
                        ? eq(platformAppSessionStatusWebhook.appId, appId)
                        : and(
                              eq(platformAppSessionStatusWebhook.appId, appId),
                              eq(platformAppSessionStatusWebhook.secretId, secretId),
                          ),
                ),
        );
}

function decode(row: typeof platformAppSessionStatusWebhook.$inferSelect): StoredAppSessionStatusWebhook {
    return {
        appId: row.appId,
        enabled: row.enabled === 1,
        endpoint: row.endpoint,
        secretCiphertext: row.secretCiphertext,
        secretId: row.secretId,
        secretNonce: row.secretNonce,
    };
}
