import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { acpSession } from "../../schema/acp-session-store/index.ts";
import type { LocalSqliteDatabase } from "../sqlite/local-sqlite-database.ts";

/** One saved session row. The list columns hold JSON text that the session record decodes. */
export interface AcpSessionRow {
    readonly additionalDirectories: string;
    readonly agentId: string;
    readonly configurations: string;
    readonly cwd: string;
    readonly nativeSessionId: string;
    readonly prompted: boolean;
    readonly sessionId: string;
    readonly title: string;
    readonly updatedAt: string;
}

const acpSessionRowSchema = z.object({
    additionalDirectories: z.string(),
    agentId: z.string(),
    configurations: z.string(),
    cwd: z.string(),
    nativeSessionId: z.string(),
    prompted: z.boolean(),
    sessionId: z.string(),
    title: z.string(),
    updatedAt: z.string(),
});

function decodeRow(value: unknown): AcpSessionRow {
    return acpSessionRowSchema.parse(value);
}

/** The saved session rows. Closing the table closes the database it shares with the position table. */
export class AcpSessionTable {
    readonly #database: LocalSqliteDatabase;

    constructor(database: LocalSqliteDatabase) {
        this.#database = database;
    }

    readonly close = (): void => this.#database.close();

    readonly findNative = (agentId: string, nativeSessionId: string): readonly AcpSessionRow[] =>
        this.#database.orm
            .select()
            .from(acpSession)
            .where(and(eq(acpSession.agentId, agentId), eq(acpSession.nativeSessionId, nativeSessionId)))
            .all()
            .map(decodeRow);

    readonly list = (): readonly AcpSessionRow[] =>
        this.#database.orm.select().from(acpSession).orderBy(desc(acpSession.updatedAt)).all().map(decodeRow);

    readonly read = (sessionId: string): AcpSessionRow | undefined => {
        const row = this.#database.orm.select().from(acpSession).where(eq(acpSession.sessionId, sessionId)).get();
        return row === undefined ? undefined : decodeRow(row);
    };

    readonly remove = (sessionId: string): void => {
        this.#database.orm.delete(acpSession).where(eq(acpSession.sessionId, sessionId)).run();
    };

    readonly upsert = (row: AcpSessionRow): void => {
        this.#database.orm
            .insert(acpSession)
            .values(row)
            .onConflictDoUpdate({ target: acpSession.sessionId, set: row })
            .run();
    };
}
