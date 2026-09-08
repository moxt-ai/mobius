import { DatabaseSync } from "node:sqlite";

import type { SessionSqlDatabase, SessionSqlRow, SessionSqlValue } from "@moxt-ai/mobius-relay-core";

function decodeRow(value: unknown): SessionSqlRow {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("SQLite returned an invalid row");
    }
    const decoded: Record<string, SessionSqlValue> = {};
    for (const [key, field] of Object.entries(value)) {
        if (field !== null && typeof field !== "number" && typeof field !== "string") {
            throw new Error("SQLite returned an unsupported column value");
        }
        decoded[key] = field;
    }
    return decoded;
}

export class NodeSqlDatabase implements SessionSqlDatabase {
    readonly #database: DatabaseSync;

    constructor(path: string) {
        this.#database = new DatabaseSync(path);
        this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    }

    readonly close = (): void => {
        this.#database.close();
    };

    readonly exec = (script: string): void => {
        this.#database.exec(script);
    };

    readonly query = (sql: string, values: readonly SessionSqlValue[] = []): readonly SessionSqlRow[] =>
        this.#database
            .prepare(sql)
            .all(...values)
            .map(decodeRow);

    readonly run = (sql: string, values: readonly SessionSqlValue[] = []): { readonly changes: number } => {
        const result = this.#database.prepare(sql).run(...values);
        return { changes: Number(result.changes) };
    };

    readonly transaction = <T>(operation: () => T): T => {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
            const result = operation();
            this.#database.exec("COMMIT");
            return result;
        } catch (error) {
            this.#database.exec("ROLLBACK");
            throw error;
        }
    };
}
