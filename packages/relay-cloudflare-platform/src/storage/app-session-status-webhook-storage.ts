import { and, eq, exists, sql } from "drizzle-orm";
import type {
    AppSessionStatusWebhookWriteResult,
    StoredAppSessionStatusWebhook,
} from "../entity/app-session-status-webhook.ts";
import type { PlatformAuditRecord } from "../entity/platform-records.ts";
import { platformAppSessionStatusWebhook, platformProject } from "../schema/d1/index.ts";
import { activeAppConfigurationTarget, appConfigurationAudit } from "./app-configuration-write.ts";
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

    /** Stores the first webhook for an active App; a competing creation is reported as a conflict. */
    readonly create = async (
        value: StoredAppSessionStatusWebhook,
        now: number,
        audit: PlatformAuditRecord,
    ): Promise<AppSessionStatusWebhookWriteResult> => {
        const target = activeAppConfigurationTarget(this.#database, value.appId).as("active_app");
        const [result, , active] = await this.#database.batch([
            this.#database
                .insert(platformAppSessionStatusWebhook)
                .select(
                    this.#database
                        .select({
                            appId: target.appId,
                            enabled: sql<number>`${value.enabled ? 1 : 0}`.as("enabled"),
                            endpoint: sql<string>`${value.endpoint}`.as("endpoint"),
                            secretId: sql<string>`${value.secretId}`.as("secretId"),
                            secretCiphertext: sql<string>`${value.secretCiphertext}`.as("secretCiphertext"),
                            secretNonce: sql<string>`${value.secretNonce}`.as("secretNonce"),
                            createdAt: sql<number>`${now}`.as("createdAt"),
                            updatedAt: sql<number>`${now}`.as("updatedAt"),
                        })
                        .from(target)
                        .where(eq(target.appId, value.appId)),
                )
                .onConflictDoNothing({ target: platformAppSessionStatusWebhook.appId })
                .returning(),
            this.#auditWhere(audit, value.appId, value.secretId),
            activeAppConfigurationTarget(this.#database, value.appId),
        ]);
        return writeResult(result, active);
    };

    /** Changes delivery settings only; the signing secret belongs to creation and rotation. */
    readonly updateSettings = async (
        appId: string,
        enabled: boolean,
        endpoint: string,
        now: number,
        audit: PlatformAuditRecord,
    ): Promise<AppSessionStatusWebhookWriteResult> => {
        const [result, , active] = await this.#database.batch([
            this.#database
                .update(platformAppSessionStatusWebhook)
                .set({ enabled: enabled ? 1 : 0, endpoint, updatedAt: now })
                .where(
                    and(
                        eq(platformAppSessionStatusWebhook.appId, appId),
                        exists(activeAppConfigurationTarget(this.#database, appId)),
                    ),
                )
                .returning(),
            this.#auditWhere(audit, appId, null),
            activeAppConfigurationTarget(this.#database, appId),
        ]);
        return writeResult(result, active);
    };

    /** Replaces the secret only while its App is active and it is still the secret the caller read. */
    readonly rotateSecret = async (
        appId: string,
        previousSecretId: string,
        secret: Pick<StoredAppSessionStatusWebhook, "secretCiphertext" | "secretId" | "secretNonce">,
        now: number,
        audit: PlatformAuditRecord,
    ): Promise<AppSessionStatusWebhookWriteResult> => {
        const [result, , active] = await this.#database.batch([
            this.#database
                .update(platformAppSessionStatusWebhook)
                .set({ ...secret, updatedAt: now })
                .where(
                    and(
                        eq(platformAppSessionStatusWebhook.appId, appId),
                        eq(platformAppSessionStatusWebhook.secretId, previousSecretId),
                        exists(activeAppConfigurationTarget(this.#database, appId)),
                    ),
                )
                .returning(),
            this.#auditWhere(audit, appId, secret.secretId),
            activeAppConfigurationTarget(this.#database, appId),
        ]);
        return writeResult(result, active);
    };

    /**
     * The audit event commits with the change it records and exists only if that change took effect: the webhook
     * row exists, and when a secret was written, it holds that secret.
     */
    readonly #auditWhere = (audit: PlatformAuditRecord, appId: string, secretId: string | null) =>
        appConfigurationAudit(
            this.#database,
            audit,
            exists(
                this.#database
                    .select({ appId: platformAppSessionStatusWebhook.appId })
                    .from(platformAppSessionStatusWebhook)
                    .where(
                        and(
                            eq(platformAppSessionStatusWebhook.appId, appId),
                            secretId === null ? undefined : eq(platformAppSessionStatusWebhook.secretId, secretId),
                        ),
                    ),
            ),
        );
}

function writeResult(
    rows: readonly (typeof platformAppSessionStatusWebhook.$inferSelect)[],
    active: readonly { readonly appId: string }[],
): AppSessionStatusWebhookWriteResult {
    const row = rows[0];
    if (row !== undefined) {
        return { kind: "stored", webhook: decode(row) };
    }
    return active.length === 0 ? { kind: "app-unavailable" } : { kind: "conflict" };
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
