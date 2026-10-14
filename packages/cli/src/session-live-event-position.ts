import { eq } from "drizzle-orm";
import { z } from "zod";
import type { LocalSqliteDatabase } from "./infra/local-sqlite-database.ts";
import { sessionLiveEventPositionAllocation } from "./schema/acp-session-store/index.ts";

const INITIAL_POSITION = 10 ** 4;
const allocationRowSchema = z.object({ allocatedPosition: z.number().int().safe().nonnegative() });

export interface SessionLiveEventPosition {
    readonly allocate: (sessionId: string) => number;
}

export class SqliteSessionLiveEventPosition implements SessionLiveEventPosition {
    readonly #localDatabase: LocalSqliteDatabase;

    constructor(localDatabase: LocalSqliteDatabase) {
        this.#localDatabase = localDatabase;
    }

    readonly allocate = (sessionId: string): number =>
        this.#localDatabase.transaction(() => {
            const persisted = this.#localDatabase.orm
                .select({ allocatedPosition: sessionLiveEventPositionAllocation.allocatedPosition })
                .from(sessionLiveEventPositionAllocation)
                .where(eq(sessionLiveEventPositionAllocation.sessionId, sessionId))
                .get();
            if (persisted === undefined) {
                this.#localDatabase.orm.insert(sessionLiveEventPositionAllocation).values({ sessionId }).run();
                return INITIAL_POSITION;
            }
            const { allocatedPosition } = allocationRowSchema.parse(persisted);
            if (allocatedPosition === Number.MAX_SAFE_INTEGER) {
                throw new Error("The live Session event position allocation is exhausted");
            }
            const nextPosition = allocatedPosition + 1;
            this.#localDatabase.orm
                .update(sessionLiveEventPositionAllocation)
                .set({ allocatedPosition: nextPosition })
                .where(eq(sessionLiveEventPositionAllocation.sessionId, sessionId))
                .run();
            return nextPosition;
        });
}
