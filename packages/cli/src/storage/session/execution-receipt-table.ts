import { sessionEventPayloadSchema } from "@moxt-ai/mobius-sdk/protocol";
import { and, asc, desc, eq, isNotNull, notInArray, type SQL } from "drizzle-orm";
import { z } from "zod";
import { executionIdentity, executionReceipt } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

const receiptSchema = z
    .object({
        commandId: z.string(),
        sessionId: z.string(),
        commandHash: z.string(),
        attemptId: z.string(),
        updatedAt: z.string(),
        started: z.boolean(),
        outcome: z.string().nullable(),
    })
    .readonly();
export type PersistedExecutionReceipt = z.infer<typeof receiptSchema>;

const identitySchema = z.object({ sessionId: z.string(), commandHash: z.string() }).readonly();

/** Keep rollback readers working without treating their state column as an independent fact. */
function legacyState(receipt: PersistedExecutionReceipt): string {
    if (receipt.outcome === null) {
        return receipt.started ? "running" : "dispatching";
    }
    const event = sessionEventPayloadSchema.parse(JSON.parse(receipt.outcome));
    return event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed"
        ? event.payload.stopReason === "cancelled"
            ? "cancelled"
            : "succeeded"
        : "failed";
}

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
    readonly save = (receipt: PersistedExecutionReceipt, terminalLimit: number): readonly string[] =>
        this.#database.transaction(() => {
            const row = { ...receipt, state: legacyState(receipt) };
            this.#database.orm
                .insert(executionReceipt)
                .values(row)
                .onConflictDoUpdate({ target: executionReceipt.commandId, set: row })
                .run();
            if (receipt.outcome === null) {
                return [];
            }
            const retained = this.#database.orm
                .select({ commandId: executionReceipt.commandId })
                .from(executionReceipt)
                .where(and(eq(executionReceipt.sessionId, receipt.sessionId), isNotNull(executionReceipt.outcome)))
                .orderBy(desc(executionReceipt.updatedAt), desc(executionReceipt.commandId))
                .limit(terminalLimit)
                .all();
            if (retained.length === terminalLimit) {
                return this.#remove(
                    and(
                        eq(executionReceipt.sessionId, receipt.sessionId),
                        isNotNull(executionReceipt.outcome),
                        notInArray(
                            executionReceipt.commandId,
                            retained.map((row) => row.commandId),
                        ),
                    ),
                );
            }
            return [];
        });
    readonly remove = (commandId: string): void => {
        this.#database.transaction(() => this.#remove(eq(executionReceipt.commandId, commandId)));
    };
    readonly #remove = (condition: SQL | undefined): readonly string[] => {
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
        return this.#database.orm
            .delete(executionReceipt)
            .where(condition)
            .returning({ commandId: executionReceipt.commandId })
            .all()
            .map((row) => row.commandId);
    };
}
