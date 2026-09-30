import { relayDrizzle, type SqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import { eq } from "drizzle-orm";
import { standaloneProject } from "../schema/d1/standalone-project.ts";

export interface StandaloneProjectRecord {
    readonly ownerTokenHash: string;
    readonly projectId: string;
}

export class StandaloneProjectStorage {
    readonly #database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly create = async (
        projectId: string,
        ownerTokenHash: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        await relayDrizzle(this.#database, signal)
            .insert(standaloneProject)
            .values({ createdAt: now, ownerTokenHash, projectId });
        signal.throwIfAborted();
    };

    readonly read = async (projectId: string, signal: AbortSignal): Promise<StandaloneProjectRecord | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({ ownerTokenHash: standaloneProject.ownerTokenHash, projectId: standaloneProject.projectId })
            .from(standaloneProject)
            .where(eq(standaloneProject.projectId, projectId))
            .limit(1);
        signal.throwIfAborted();
        return rows[0] ?? null;
    };
}
