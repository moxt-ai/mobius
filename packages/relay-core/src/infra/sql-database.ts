export type { DoSqlDatabase, DoSqlRow, DoSqlValue } from "./do-sql-database.ts";
export { type RelayDrizzleDatabase, relayDrizzle } from "./drizzle-database.ts";

export class DatabaseError extends Error {
    readonly code: "database_unavailable" | "database_timeout" | "database_statement_invalid";
    constructor(code: DatabaseError["code"], message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "DatabaseError";
        this.code = code;
    }
}

export interface SqlResult<Row> {
    readonly results: readonly Row[];
    readonly meta: { readonly changes: number };
}

export interface SqlStatement {
    readonly bind: (...values: readonly unknown[]) => SqlStatement;
    readonly first: <Row>(signal: AbortSignal) => Promise<Row | null>;
    readonly all: <Row>(signal: AbortSignal) => Promise<SqlResult<Row>>;
    readonly run: (signal: AbortSignal) => Promise<SqlResult<unknown>>;
}

export interface SqlDatabase {
    readonly prepare: (sql: string) => SqlStatement;
    readonly batch: (
        statements: readonly SqlStatement[],
        signal: AbortSignal,
    ) => Promise<readonly SqlResult<unknown>[]>;
}
