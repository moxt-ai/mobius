import {
    type RuntimeUpgradeResult,
    runtimeUpgradeSnapshotSchema,
    storedUpgradeResultSchema,
} from "@moxt-ai/mobius-protocol";
import { type DoSqlDatabase, runtimeUpgradeState } from "@moxt-ai/mobius-relay-core/database";
import { eq } from "drizzle-orm";
export class RuntimeUpgradeStorage {
    private readonly database: DoSqlDatabase;
    constructor(database: DoSqlDatabase) {
        this.database = database;
    }
    readonly touch = (runtimeId: string, projectId: string, now: number): void => {
        this.database.orm
            .insert(runtimeUpgradeState)
            .values({ singleton: 1, runtimeId, projectId, lastSeen: now })
            .onConflictDoUpdate({ target: runtimeUpgradeState.singleton, set: { lastSeen: now } })
            .run();
    };
    readonly read = (runtimeId: string, projectId: string, online: boolean) => {
        const row = this.database.orm.select().from(runtimeUpgradeState).get();
        return runtimeUpgradeSnapshotSchema.parse({
            runtimeId,
            projectId,
            name: "",
            matched: false,
            connection: online ? "online" : "offline",
            lastSeen: row?.lastSeen ?? null,
            version: row?.version ?? null,
            attempt: row?.attempt ? JSON.parse(row.attempt) : null,
            latest: row?.latest ? JSON.parse(row.latest) : null,
            lastFailure: row?.lastFailure ? JSON.parse(row.lastFailure) : null,
        });
    };
    readonly version = (version: string): void => {
        this.database.orm
            .update(runtimeUpgradeState)
            .set({ version })
            .where(eq(runtimeUpgradeState.singleton, 1))
            .run();
    };
    readonly attempt = (attempt: {
        readonly requestId: string;
        readonly revision: string;
        readonly version: string;
        readonly sentAt: number;
    }): void => {
        this.database.orm
            .update(runtimeUpgradeState)
            .set({ attempt: JSON.stringify(attempt) })
            .where(eq(runtimeUpgradeState.singleton, 1))
            .run();
    };
    readonly result = (result: RuntimeUpgradeResult, now: number): boolean => {
        const row = this.database.orm.select().from(runtimeUpgradeState).get();
        const previous = row?.lastFailure ? storedUpgradeResultSchema.parse(JSON.parse(row.lastFailure)) : null;
        const stored = JSON.stringify({ receivedAt: now, result });
        this.database.orm
            .update(runtimeUpgradeState)
            .set({
                version: result.version,
                latest: stored,
                ...(result.outcome.status === "failed" ? { lastFailure: stored } : {}),
            })
            .where(eq(runtimeUpgradeState.singleton, 1))
            .run();
        return result.outcome.status === "failed" && previous?.result?.requestId !== result.requestId;
    };
}
