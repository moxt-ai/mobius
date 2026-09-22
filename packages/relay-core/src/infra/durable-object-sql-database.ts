import { drizzle } from "drizzle-orm/durable-sqlite";
import * as sessionDoSchema from "../schema/session-do/index.ts";
import {
    DatabaseError,
    type DoSqlDatabase,
    type DoSqlRow,
    type DoSqlValue,
    type SqlDatabase,
    type SqlStatement,
} from "./sql-database.ts";

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
    readonly orm: DoSqlDatabase["orm"];

    constructor(storage: DurableObjectStorage) {
        this.#storage = storage;
        this.orm = drizzle(storage, { schema: sessionDoSchema });
    }

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

class DurableObjectStatement implements SqlStatement {
    readonly database: DurableObjectSqlDatabase;
    readonly sql: string;
    readonly values: readonly DoSqlValue[];

    constructor(database: DurableObjectSqlDatabase, sql: string, values: readonly DoSqlValue[] = []) {
        this.database = database;
        this.sql = sql;
        this.values = values;
    }

    readonly bind: SqlStatement["bind"] = (...values) =>
        new DurableObjectStatement(this.database, this.sql, values.map(databaseValue));

    readonly first: SqlStatement["first"] = async <Row>(signal: AbortSignal) => {
        signal.throwIfAborted();
        const row = this.database.query(this.sql, this.values)[0];
        signal.throwIfAborted();
        return row === undefined ? null : decodeResult<Row>(row);
    };

    readonly all: SqlStatement["all"] = async <Row>(signal: AbortSignal) => {
        signal.throwIfAborted();
        const results = this.database.query(this.sql, this.values).map(decodeResult<Row>);
        signal.throwIfAborted();
        return { results, meta: { changes: 0 } };
    };

    readonly run: SqlStatement["run"] = async (signal) => {
        signal.throwIfAborted();
        const result = this.database.run(this.sql, this.values);
        signal.throwIfAborted();
        return { results: [], meta: result };
    };
}

function databaseValue(value: unknown): DoSqlValue {
    if (value === null || typeof value === "string" || typeof value === "number" || value instanceof ArrayBuffer) {
        return value;
    }
    throw new DatabaseError("database_statement_invalid", "SQLite received an unsupported bound value");
}

function decodeResult<Row>(row: DoSqlRow): Row {
    return JSON.parse(JSON.stringify(row));
}

/** Async SQL contract for data stored in the current Durable Object. */
export class DurableObjectDatabaseAdapter implements SqlDatabase {
    readonly #database: DurableObjectSqlDatabase;

    constructor(storage: DurableObjectStorage) {
        this.#database = new DurableObjectSqlDatabase(storage);
    }

    readonly prepare: SqlDatabase["prepare"] = (sql) => new DurableObjectStatement(this.#database, sql);

    readonly batch: SqlDatabase["batch"] = async (statements, signal) => {
        signal.throwIfAborted();
        const operations: DurableObjectStatement[] = [];
        for (const statement of statements) {
            if (!(statement instanceof DurableObjectStatement) || statement.database !== this.#database) {
                throw new DatabaseError("database_statement_invalid", "SQL statements must belong to one database");
            }
            operations.push(statement);
        }
        const results = this.#database.transaction(() =>
            operations.map((statement) => {
                const result = this.#database.run(statement.sql, statement.values);
                return { results: [], meta: result };
            }),
        );
        signal.throwIfAborted();
        return results;
    };
}
