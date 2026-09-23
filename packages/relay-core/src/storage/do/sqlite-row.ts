import { SessionRuntimeError } from "../../entity/do/session.ts";
import type { DoSqlRow } from "../../infra/do-sql-database.ts";
export function rowString(row: DoSqlRow, key: string): string {
    const value = Reflect.get(row, key);
    if (typeof value !== "string") {
        throw new SessionRuntimeError("session_storage_unavailable", "The session database returned an invalid record");
    }
    return value;
}

export function rowNullableString(row: DoSqlRow, key: string): string | null {
    const value = Reflect.get(row, key);
    if (value === null) {
        return null;
    }
    if (typeof value !== "string") {
        throw new SessionRuntimeError("session_storage_unavailable", "The session database returned an invalid record");
    }
    return value;
}

export function rowNumber(row: DoSqlRow, key: string): number {
    const value = Reflect.get(row, key);
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session database returned an invalid record");
    }
    return value;
}
