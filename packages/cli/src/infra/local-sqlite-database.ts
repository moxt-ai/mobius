import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { z } from "zod";

export interface LocalSqliteMigration {
    readonly name: string;
    readonly sql: string;
}

export class LocalSqliteDatabase {
    readonly orm: NodeSQLiteDatabase;
    readonly #sqlite: DatabaseSync;

    constructor(
        path: string,
        label: string,
        migrations: readonly LocalSqliteMigration[],
        pragmas: readonly string[] = [],
    ) {
        mkdirSync(dirname(path), { mode: 0o700, recursive: true });
        this.#sqlite = new DatabaseSync(path);
        chmodSync(path, 0o600);
        try {
            for (const pragma of pragmas) {
                this.#sqlite.exec(pragma);
            }
            this.#migrate(label, migrations);
            this.orm = drizzle({ client: this.#sqlite });
        } catch (error) {
            this.#sqlite.close();
            throw error;
        }
    }

    readonly #migrate = (label: string, migrations: readonly LocalSqliteMigration[]): void => {
        const version = z
            .object({ user_version: z.number().int().nonnegative() })
            .parse(this.#sqlite.prepare("PRAGMA user_version").get()).user_version;
        if (version > migrations.length) {
            throw new Error(`The ${label} was created by a newer Mobius version`);
        }
        for (let index = version; index < migrations.length; index += 1) {
            const migration = migrations[index];
            if (migration === undefined) {
                throw new Error(`The ${label} migration is unavailable`);
            }
            this.transaction(() => {
                this.#sqlite.exec(migration.sql);
                this.#sqlite.exec(`PRAGMA user_version = ${index + 1}`);
            });
        }
    };

    readonly transaction = <Result>(operation: () => Result): Result => {
        this.#sqlite.exec("BEGIN IMMEDIATE");
        try {
            const result = operation();
            this.#sqlite.exec("COMMIT");
            return result;
        } catch (error) {
            this.#sqlite.exec("ROLLBACK");
            throw error;
        }
    };

    readonly close = (): void => this.#sqlite.close();
}
