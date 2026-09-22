import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type {
    DoDrizzleDatabase,
    DoSqlDatabase,
    DoSqlRow,
    DoSqlValue,
} from "../../packages/relay-core/src/infra/do-sql-database.ts";
import * as sessionDoSchema from "../../packages/relay-core/src/schema/session-do/index.ts";

function input(value: DoSqlValue): SQLInputValue {
    return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

/**
 * Adapts the synchronous test database to the storage members the Drizzle
 * Durable Object driver reads. Key-value, alarm, and bookmark operations stay
 * unsupported because the session storages never issue them.
 */
function createStorage(database: {
    readonly query: (sql: string, values?: readonly DoSqlValue[]) => readonly DoSqlRow[];
    readonly transaction: <T>(operation: () => T) => T;
}): DurableObjectStorage {
    const unsupported = (operation: string): never => {
        throw new Error(`The test database does not support ${operation}`);
    };
    return {
        get sql() {
            const cursor = <T extends Record<string, SqlStorageValue>>(rows: readonly T[]) => {
                const iterator = rows[Symbol.iterator]();
                return {
                    get columnNames() {
                        return Object.keys(rows[0] ?? {});
                    },
                    next: () => {
                        const result = iterator.next();
                        return result.done ? ({ done: true } as const) : { done: false as const, value: result.value };
                    },
                    one: (): T => rows[0] ?? ({} as T),
                    raw: <U extends SqlStorageValue[]>() => {
                        const rawRows = rows.map((row) => Object.values(row) as U);
                        const rawIterator = rawRows[Symbol.iterator]();
                        return {
                            [Symbol.iterator]: () => rawIterator,
                            next: () => rawIterator.next(),
                            toArray: () => rawRows,
                        };
                    },
                    get rowsRead() {
                        return rows.length;
                    },
                    get rowsWritten() {
                        return 0;
                    },
                    toArray: (): T[] => [...rows],
                    [Symbol.iterator]: (): IterableIterator<T> => rows[Symbol.iterator](),
                };
            };
            return {
                exec: <T extends Record<string, SqlStorageValue>>(query: string, ...values: readonly DoSqlValue[]) =>
                    // The cursor shape follows the rows SQLite already returned, so
                    // the generic only names the record the driver will map onto it.
                    cursor(database.query(query, values) as readonly T[]),
                get databaseSize() {
                    return 0;
                },
                Cursor: SqlStorageCursor,
                Statement: SqlStorageStatement,
            };
        },
        get kv(): SyncKvStorage {
            return unsupported("key-value storage");
        },
        get: () => unsupported("key-value reads"),
        list: () => unsupported("key-value listing"),
        put: () => unsupported("key-value writes"),
        delete: () => unsupported("key-value deletes"),
        deleteAll: () => unsupported("key-value deletes"),
        transaction: () => unsupported("asynchronous transactions"),
        getAlarm: () => unsupported("alarms"),
        setAlarm: () => unsupported("alarms"),
        deleteAlarm: () => unsupported("alarms"),
        sync: () => unsupported("storage synchronization"),
        transactionSync: <T>(operation: () => T): T => database.transaction(operation),
        getCurrentBookmark: () => unsupported("bookmarks"),
        getBookmarkForTime: () => unsupported("bookmarks"),
        onNextSessionRestoreBookmark: () => unsupported("bookmarks"),
    };
}

export class TestSqliteDatabase implements DoSqlDatabase, Disposable {
    readonly #database = new DatabaseSync(":memory:");
    readonly #orm: DoDrizzleDatabase = drizzle(createStorage(this), { schema: sessionDoSchema });
    readonly exec = (script: string): void => this.#database.exec(script);
    readonly query = (sql: string, values: readonly DoSqlValue[] = []): readonly DoSqlRow[] =>
        this.#database
            .prepare(sql)
            .all(...values.map(input))
            .map((result) => {
                const row: Record<string, DoSqlValue> = {};
                for (const [key, value] of Object.entries(result)) {
                    if (typeof value === "bigint") {
                        throw new Error("SQLite returned an unsupported integer");
                    }
                    row[key] = value instanceof Uint8Array ? new Uint8Array(value).buffer : value;
                }
                return row;
            });
    readonly run = (sql: string, values: readonly DoSqlValue[] = []) => ({
        changes: Number(this.#database.prepare(sql).run(...values.map(input)).changes),
    });
    readonly transaction = <T>(operation: () => T): T => {
        this.exec("SAVEPOINT operation");
        try {
            const result = operation();
            this.exec("RELEASE operation");
            return result;
        } catch (cause) {
            this.exec("ROLLBACK TO operation; RELEASE operation");
            throw cause;
        }
    };
    get orm(): DoDrizzleDatabase {
        return this.#orm;
    }
    [Symbol.dispose](): void {
        this.#database.close();
    }
}
