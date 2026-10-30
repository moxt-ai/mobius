import { eq } from "drizzle-orm";
import { z } from "zod";
import { cancelledCommand } from "../../schema/command-cancellation/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

const cancellationSchema = z.object({ commandId: z.string(), sessionId: z.string() }).readonly();
export type PersistedCommandCancellation = z.infer<typeof cancellationSchema>;

/** Owns the cancellation ledger's database; older Runtimes leave this additive store untouched. */
export class CommandCancellationTable {
    readonly #database: LocalSqliteDatabase;

    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }

    readonly close = (): void => this.#database.close();

    readonly read = (commandId: string): PersistedCommandCancellation | undefined => {
        const row = this.#database.orm
            .select()
            .from(cancelledCommand)
            .where(eq(cancelledCommand.commandId, commandId))
            .get();
        return row === undefined ? undefined : cancellationSchema.parse(row);
    };

    readonly retain = (cancellations: readonly PersistedCommandCancellation[]): void => {
        this.#database.transaction(() => {
            for (const cancellation of cancellations) {
                this.#database.orm.insert(cancelledCommand).values(cancellation).onConflictDoNothing().run();
            }
        });
    };
}
