import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import * as schema from "../schema/index.ts";
import type { SqlDatabase, SqlResult } from "./sql-database.ts";

export type RelayDrizzleDatabase = SqliteRemoteDatabase<typeof schema>;

function isRow(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowValues(row: Readonly<Record<string, unknown>>): unknown[] {
    return Object.values(row);
}

function resultRows(result: SqlResult<unknown>): unknown[][] {
    return result.results.map((value) => {
        if (!isRow(value)) {
            throw new Error("SQLite returned an invalid row");
        }
        return rowValues(value);
    });
}

export function relayDrizzle(database: SqlDatabase, signal: AbortSignal): RelayDrizzleDatabase {
    return drizzle(
        async (query, params, method) => {
            const statement = database.prepare(query).bind(...params);
            if (method === "run") {
                await statement.run(signal);
                return { rows: [] };
            }
            if (method === "get") {
                const row = await statement.first<Readonly<Record<string, unknown>>>(signal);
                return { rows: row === null ? [] : rowValues(row) };
            }
            const result = await statement.all<Readonly<Record<string, unknown>>>(signal);
            return { rows: resultRows(result) };
        },
        async (batch) => {
            const statements = batch.map((item) => database.prepare(item.sql).bind(...item.params));
            const results = await database.batch(statements, signal);
            return results.map((result) => ({ rows: resultRows(result) }));
        },
        { schema },
    );
}
