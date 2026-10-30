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
        admissionOrder: z.number().int().positive().safe(),
        updatedAt: z.string(),
        started: z.boolean(),
        outcome: z.string().nullable(),
    })
    .readonly();
export type PersistedExecutionReceipt = z.infer<typeof receiptSchema>;

const identitySchema = z
    .object({
        commandId: z.string(),
        sessionId: z.string(),
        commandHash: z.string(),
    })
    .readonly();
export type PersistedExecutionIdentity = z.infer<typeof identitySchema>;

/** Prompt bodies and Agent error text never enter the execution ledger. */
export class ExecutionReceiptTable {
    readonly #database: LocalSqliteDatabase;
    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }
    readonly identity = (commandId: string): z.infer<typeof identitySchema> | undefined => {
        const row = this.#database.orm
            .select()
            .from(executionIdentity)
            .where(eq(executionIdentity.commandId, commandId))
            .get();
        return row === undefined ? undefined : identitySchema.parse(row);
    };
    readonly list = (): readonly PersistedExecutionReceipt[] =>
        this.#database.orm
            .select()
            .from(executionReceipt)
            .orderBy(asc(executionReceipt.admissionOrder), asc(executionReceipt.commandId))
            .all()
            .map((row) => receiptSchema.parse(row));
    /** Backfills identities from receipts written before replay reasons were stored independently. */
    readonly retainIdentities = (identities: readonly PersistedExecutionIdentity[]): void => {
        this.#database.transaction(() => {
            for (const identity of identities) {
                this.#retainIdentity(identity);
            }
        });
    };
    readonly #retainIdentity = (identity: PersistedExecutionIdentity): void => {
        this.#database.orm.insert(executionIdentity).values(identity).onConflictDoNothing().run();
    };
    readonly save = (
        receipt: PersistedExecutionReceipt,
        terminalLimit: number,
        identityHash: string | null,
    ): readonly string[] =>
        this.#database.transaction(() => {
            if (identityHash !== null) {
                this.#retainIdentity({
                    commandId: receipt.commandId,
                    sessionId: receipt.sessionId,
                    commandHash: identityHash,
                });
            }
            this.#database.orm
                .insert(executionReceipt)
                .values(receipt)
                .onConflictDoUpdate({ target: executionReceipt.commandId, set: receipt })
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
        // Replay protection was committed with the execution or cancellation, before any receipt can be evicted.
        return this.#database.orm
            .delete(executionReceipt)
            .where(condition)
            .returning({ commandId: executionReceipt.commandId })
            .all()
            .map((row) => row.commandId);
    };
}
