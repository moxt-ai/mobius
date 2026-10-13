import { eq } from "drizzle-orm";
import type { StoredAppSessionStatusWebhook } from "../entity/app-session-status-webhook.ts";
import { platformAppSessionStatusWebhook, platformProject } from "../schema/d1/index.ts";
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

    readonly write = async (
        value: StoredAppSessionStatusWebhook,
        now: number,
    ): Promise<StoredAppSessionStatusWebhook> => {
        const row = {
            appId: value.appId,
            enabled: value.enabled ? 1 : 0,
            endpoint: value.endpoint,
            secretCiphertext: value.secretCiphertext,
            secretId: value.secretId,
            secretNonce: value.secretNonce,
        };
        const result = await this.#database
            .insert(platformAppSessionStatusWebhook)
            .values({ ...row, createdAt: now, updatedAt: now })
            .onConflictDoUpdate({
                target: platformAppSessionStatusWebhook.appId,
                set: { ...row, updatedAt: now },
            })
            .returning();
        const stored = result[0];
        if (stored === undefined) {
            throw new Error("The App Session status webhook could not be stored");
        }
        return decode(stored);
    };
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
