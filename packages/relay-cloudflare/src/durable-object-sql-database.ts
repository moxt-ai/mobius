import type { SessionSqlDatabase, SessionSqlRow, SessionSqlValue } from "@moxt-ai/mobius-relay-core";

function decodeRow(value: Readonly<Record<string, SqlStorageValue>>): SessionSqlRow {
    const row: Record<string, SessionSqlValue> = {};
    for (const [key, field] of Object.entries(value)) {
        if (field !== null && typeof field !== "number" && typeof field !== "string") {
            throw new Error("Durable Object SQLite returned an unsupported value");
        }
        row[key] = field;
    }
    return row;
}

export class DurableObjectSqlDatabase implements SessionSqlDatabase {
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
    }

    readonly exec = (script: string): void => {
        this.#storage.sql.exec(script);
    };

    readonly query = (sql: string, values: readonly SessionSqlValue[] = []): readonly SessionSqlRow[] =>
        this.#storage.sql
            .exec(sql, ...values)
            .toArray()
            .map(decodeRow);

    readonly run = (sql: string, values: readonly SessionSqlValue[] = []): { readonly changes: number } => ({
        changes: this.#storage.sql.exec(sql, ...values).rowsWritten,
    });

    readonly transaction = <T>(operation: () => T): T => this.#storage.transactionSync(operation);
}
