import { eq } from "drizzle-orm";
import { z } from "zod";
import { sessionLiveEventPositionAllocation } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

const allocationRowSchema = z.object({ allocatedPosition: z.number().int().safe().nonnegative() });

/** The highest live event position reserved for each session. */
export class LiveEventPositionTable {
    readonly #database: LocalSqliteDatabase;

    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }

    readonly transaction = <Result>(operation: () => Result): Result => this.#database.transaction(operation);

    readonly read = (sessionId: string): number | undefined => {
        const persisted = this.#database.orm
            .select({ allocatedPosition: sessionLiveEventPositionAllocation.allocatedPosition })
            .from(sessionLiveEventPositionAllocation)
            .where(eq(sessionLiveEventPositionAllocation.sessionId, sessionId))
            .get();
        return persisted === undefined ? undefined : allocationRowSchema.parse(persisted).allocatedPosition;
    };

    readonly insert = (sessionId: string, allocatedPosition: number): void => {
        this.#database.orm.insert(sessionLiveEventPositionAllocation).values({ sessionId, allocatedPosition }).run();
    };

    readonly update = (sessionId: string, allocatedPosition: number): void => {
        this.#database.orm
            .update(sessionLiveEventPositionAllocation)
            .set({ allocatedPosition })
            .where(eq(sessionLiveEventPositionAllocation.sessionId, sessionId))
            .run();
    };
}
