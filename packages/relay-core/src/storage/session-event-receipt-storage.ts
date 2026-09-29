import { and, desc, eq, lt, or } from "drizzle-orm";
import { runtimeConnectionDurableObjectMigrations } from "../generated/runtime-connection-do-migrations.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { applyDurableObjectMigrations } from "../infra/durable-object-migrations.ts";
import { sessionEventReceipt } from "../schema/runtime-connection-do/session-event-receipt.ts";

const MAX_SESSION_EVENT_RECEIPTS = 100_000;

export type SessionEventReceiptClaim =
    | { readonly kind: "accepted" }
    | { readonly kind: "duplicate" }
    | { readonly kind: "conflict" };

export class SessionEventReceiptStorage {
    readonly #database: DoSqlDatabase;

    constructor(database: DoSqlDatabase) {
        this.#database = database;
        applyDurableObjectMigrations(database, "runtime-connection-do", runtimeConnectionDurableObjectMigrations);
    }

    readonly claim = (eventId: string, envelopeHash: string, now: number): SessionEventReceiptClaim => {
        const existing = this.#database.orm
            .select({ envelopeHash: sessionEventReceipt.envelopeHash })
            .from(sessionEventReceipt)
            .where(eq(sessionEventReceipt.eventId, eventId))
            .get();
        if (existing !== undefined) {
            return existing.envelopeHash === envelopeHash ? { kind: "duplicate" } : { kind: "conflict" };
        }
        this.#database.orm.insert(sessionEventReceipt).values({ envelopeHash, eventId, receivedAt: now }).run();
        this.prune();
        return { kind: "accepted" };
    };

    private readonly prune = (): void => {
        const cutoff = this.#database.orm
            .select({ eventId: sessionEventReceipt.eventId, receivedAt: sessionEventReceipt.receivedAt })
            .from(sessionEventReceipt)
            .orderBy(desc(sessionEventReceipt.receivedAt), desc(sessionEventReceipt.eventId))
            .limit(1)
            .offset(MAX_SESSION_EVENT_RECEIPTS - 1)
            .get();
        if (cutoff === undefined) {
            return;
        }
        this.#database.orm
            .delete(sessionEventReceipt)
            .where(
                or(
                    lt(sessionEventReceipt.receivedAt, cutoff.receivedAt),
                    and(
                        eq(sessionEventReceipt.receivedAt, cutoff.receivedAt),
                        lt(sessionEventReceipt.eventId, cutoff.eventId),
                    ),
                ),
            )
            .run();
    };
}
