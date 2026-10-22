import type { LiveEventPositionTable } from "../../storage/session/live-event-position-table.ts";

const INITIAL_POSITION = 10 ** 4;
const POSITION_RESERVATION_SIZE = 10_000;

interface PositionReservation {
    readonly next: number;
    readonly end: number;
}

export interface SessionLiveEventPosition {
    readonly allocate: (sessionId: string) => number;
}

export class SqliteSessionLiveEventPosition implements SessionLiveEventPosition {
    readonly #table: LiveEventPositionTable;
    readonly #reservations = new Map<string, PositionReservation>();

    constructor(table: LiveEventPositionTable) {
        this.#table = table;
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
        this.#table.transaction(() => {
            const persisted = this.#table.read(sessionId);
            const allocatedPosition = persisted ?? INITIAL_POSITION - 1;
            if (allocatedPosition === Number.MAX_SAFE_INTEGER) {
                throw new Error("The live Session event position allocation is exhausted");
            }
            const next = allocatedPosition + 1;
            const end = next + Math.min(POSITION_RESERVATION_SIZE - 1, Number.MAX_SAFE_INTEGER - next);
            if (persisted === undefined) {
                this.#table.insert(sessionId, end);
            } else {
                this.#table.update(sessionId, end);
            }
            return { next, end };
        });
}
