import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { DoSqlDatabase, DoSqlRow, DoSqlValue } from "../../packages/relay-core/src/infra/do-sql-database.ts";

function input(value: DoSqlValue): SQLInputValue {
    return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

export class TestSqliteDatabase implements DoSqlDatabase, Disposable {
    readonly #database = new DatabaseSync(":memory:");
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
    [Symbol.dispose](): void {
        this.#database.close();
    }
}
