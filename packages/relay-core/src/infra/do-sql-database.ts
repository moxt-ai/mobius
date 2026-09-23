import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type * as runtimeConnectionSchema from "../schema/runtime-connection-do/index.ts";

export type DoSqlValue = null | number | string | ArrayBuffer;
export type DoSqlRow = Readonly<Record<string, DoSqlValue>>;

export type DoDrizzleDatabase = DrizzleSqliteDODatabase<typeof runtimeConnectionSchema>;

export interface DoSqlDatabase {
    readonly query: (sql: string, values?: readonly DoSqlValue[]) => readonly DoSqlRow[];
    readonly run: (sql: string, values?: readonly DoSqlValue[]) => { readonly changes: number };
    readonly transaction: <T>(operation: () => T) => T;
    /** Schema-backed Drizzle query builder over the same Durable Object SQLite storage. */
    readonly orm: DoDrizzleDatabase;
}
