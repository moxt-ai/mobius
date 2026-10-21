import { eq } from "drizzle-orm";
import { z } from "zod";
import type { LocalSqliteDatabase } from "../infra/local-sqlite-database.ts";
import { sessionLiveEventPositionAllocation } from "../schema/acp-session-store/index.ts";

const INITIAL_POSITION = 10 ** 4;
const POSITION_RESERVATION_SIZE = 10_000;
const allocationRowSchema = z.object({ allocatedPosition: z.number().int().safe().nonnegative() });

interface PositionReservation {
    readonly next: number;
    readonly end: number;
}

export interface SessionLiveEventPosition {
    readonly allocate: (sessionId: string) => number;
}

export class SqliteSessionLiveEventPosition implements SessionLiveEventPosition {
    readonly #localDatabase: LocalSqliteDatabase;
    readonly #reservations = new Map<string, PositionReservation>();

    constructor(localDatabase: LocalSqliteDatabase) {
        this.#localDatabase = localDatabase;
    }

    readonly allocate = (sessionId: string): number => {
        const reservation = this.#reservations.get(sessionId) ?? this.#reserve(sessionId);
        if (reservation.next === reservation.end) {
            this.#reservations.delete(sessionId);
        } else {
            this.#reservations.set(sessionId, { next: reservation.next + 1, end: reservation.end });
        }
        return reservation.next;
    };

    // Persist the high-water mark before emitting any position in the range. A crash skips the
    // unused suffix rather than reusing positions, without a synchronous transaction per chunk.
    readonly #reserve = (sessionId: string): PositionReservation =>
        this.#localDatabase.transaction(() => {
            const persisted = this.#localDatabase.orm
                .select({ allocatedPosition: sessionLiveEventPositionAllocation.allocatedPosition })
                .from(sessionLiveEventPositionAllocation)
                .where(eq(sessionLiveEventPositionAllocation.sessionId, sessionId))
                .get();
            const allocatedPosition =
                persisted === undefined ? INITIAL_POSITION - 1 : allocationRowSchema.parse(persisted).allocatedPosition;
            if (allocatedPosition === Number.MAX_SAFE_INTEGER) {
                throw new Error("The live Session event position allocation is exhausted");
            }
            const next = allocatedPosition + 1;
            const end = next + Math.min(POSITION_RESERVATION_SIZE - 1, Number.MAX_SAFE_INTEGER - next);
            if (persisted === undefined) {
                this.#localDatabase.orm
                    .insert(sessionLiveEventPositionAllocation)
                    .values({ sessionId, allocatedPosition: end })
                    .run();
            } else {
                this.#localDatabase.orm
                    .update(sessionLiveEventPositionAllocation)
                    .set({ allocatedPosition: end })
                    .where(eq(sessionLiveEventPositionAllocation.sessionId, sessionId))
                    .run();
            }
            return { next, end };
        });
}
