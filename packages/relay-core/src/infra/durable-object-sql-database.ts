import type { DoSqlDatabase, DoSqlRow, DoSqlValue } from "./sql-database.ts";

function decodeRow(value: Readonly<Record<string, SqlStorageValue>>): DoSqlRow {
    const row: Record<string, DoSqlValue> = {};
    for (const [key, field] of Object.entries(value)) {
        if (
            field !== null &&
            typeof field !== "number" &&
            typeof field !== "string" &&
            !(field instanceof ArrayBuffer)
        ) {
            throw new Error("Durable Object SQLite returned an unsupported value");
        }
        row[key] = field;
    }
    return row;
}

export class DurableObjectSqlDatabase implements DoSqlDatabase {
    readonly #storage: DurableObjectStorage;

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
    }

    readonly exec = (script: string): void => {
        this.#storage.sql.exec(script);
    };

    readonly query = (sql: string, values: readonly DoSqlValue[] = []): readonly DoSqlRow[] =>
        this.#storage.sql
            .exec(sql, ...values)
            .toArray()
            .map(decodeRow);

    readonly run = (sql: string, values: readonly DoSqlValue[] = []): { readonly changes: number } => {
        this.#storage.sql.exec(sql, ...values);
        const result = this.#storage.sql.exec("SELECT changes() AS changes").one();
        if (typeof result["changes"] !== "number") {
            throw new Error("Durable Object SQLite returned an invalid change count");
        }
        return { changes: result["changes"] };
    };

    readonly transaction = <T>(operation: () => T): T => this.#storage.transactionSync(operation);
}
