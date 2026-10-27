import { and, asc, desc, eq, inArray, notInArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { executionIdentity, executionReceipt } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

const receiptFields = z.object({
    commandId: z.string(),
    sessionId: z.string(),
    commandHash: z.string(),
    attemptId: z.string(),
    updatedAt: z.string(),
});
const receiptSchema = z
    .discriminatedUnion("state", [
        receiptFields.extend({ state: z.literal("dispatching"), started: z.literal(false), outcome: z.null() }),
        receiptFields.extend({ state: z.literal("running"), started: z.literal(true), outcome: z.string().nullable() }),
        receiptFields.extend({
            state: z.enum(["succeeded", "failed", "cancelled"]),
            started: z.boolean(),
            outcome: z.string().nullable(),
        }),
    ])
    .readonly();
export type PersistedExecutionReceipt = z.infer<typeof receiptSchema>;

const identitySchema = z.object({ sessionId: z.string(), commandHash: z.string() }).readonly();

/** Prompt bodies and Agent error text never enter the execution ledger. */
export class ExecutionReceiptTable {
    readonly #database: LocalSqliteDatabase;
    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }
    readonly identity = (commandId: string): z.infer<typeof identitySchema> | undefined => {
        const row = this.#database.orm
            .select({ sessionId: executionIdentity.sessionId, commandHash: executionIdentity.commandHash })
            .from(executionIdentity)
            .where(eq(executionIdentity.commandId, commandId))
            .get();
        return row === undefined ? undefined : identitySchema.parse(row);
    };
    readonly list = (): readonly PersistedExecutionReceipt[] =>
        receiptSchema
            .array()
            .parse(
                this.#database.orm
                    .select()
                    .from(executionReceipt)
                    .orderBy(asc(executionReceipt.updatedAt), asc(executionReceipt.commandId))
                    .all(),
            );
    readonly save = (receipt: PersistedExecutionReceipt): void => {
        this.#database.transaction(() => {
            this.#database.orm
                .insert(executionReceipt)
                .values(receipt)
                .onConflictDoUpdate({ target: executionReceipt.commandId, set: receipt })
                .run();
            if (receipt.state === "dispatching" || receipt.state === "running") {
                return;
            }
            const retained = this.#database.orm
                .select({ commandId: executionReceipt.commandId })
                .from(executionReceipt)
                .where(
                    and(
                        eq(executionReceipt.sessionId, receipt.sessionId),
                        inArray(executionReceipt.state, ["succeeded", "failed", "cancelled"]),
                    ),
                )
                .orderBy(desc(executionReceipt.updatedAt), desc(executionReceipt.commandId))
                .limit(1024)
                .all();
            if (retained.length === 1024) {
                this.#remove(
                    and(
                        eq(executionReceipt.sessionId, receipt.sessionId),
                        inArray(executionReceipt.state, ["succeeded", "failed", "cancelled"]),
                        notInArray(
                            executionReceipt.commandId,
                            retained.map((row) => row.commandId),
                        ),
                    ),
                );
            }
        });
    };
    readonly remove = (commandId: string): void => {
        this.#database.transaction(() => this.#remove(eq(executionReceipt.commandId, commandId)));
    };
    readonly #remove = (condition: SQL | undefined): void => {
        if (condition === undefined) {
            throw new Error("Execution receipt removal requires a scope");
        }
        // Move the non-replayable identity into the ledger atomically with receipt eviction.
        // Unstarted commands remain retryable after a restart, so they leave no identity behind.
        this.#database.orm
            .insert(executionIdentity)
            .select(
                this.#database.orm
                    .select({
                        commandId: executionReceipt.commandId,
                        sessionId: executionReceipt.sessionId,
                        commandHash: executionReceipt.commandHash,
                    })
                    .from(executionReceipt)
                    .where(and(condition, eq(executionReceipt.started, true))),
            )
            .onConflictDoNothing()
            .run();
        this.#database.orm.delete(executionReceipt).where(condition).run();
    };
}
