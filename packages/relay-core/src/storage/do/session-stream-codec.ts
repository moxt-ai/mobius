import { DatabaseError } from "../../infra/sql-database.ts";
export const SESSION_STREAM_BLOCK_BYTE_LIMIT = 256 * 1_024;

export interface StoredSessionStreamEvent {
    readonly payload: string;
    readonly sequence: number;
}

export interface AppendedSessionStreamBlock {
    readonly entryIndex: number;
    readonly payload: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeStreamBlock(payload: string): readonly StoredSessionStreamEvent[] {
    let value: unknown;
    try {
        value = JSON.parse(payload);
    } catch (cause) {
        throw new DatabaseError("database_statement_invalid", "The session stream block is invalid", { cause });
    }
    if (!Array.isArray(value)) {
        throw new DatabaseError("database_statement_invalid", "The session stream block is invalid");
    }
    return value.map((entry) => {
        if (!isRecord(entry) || typeof entry["payload"] !== "string") {
            throw new DatabaseError("database_statement_invalid", "The session stream entry is invalid");
        }
        const sequence = entry["sequence"];
        if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
            throw new DatabaseError("database_statement_invalid", "The session stream entry is invalid");
        }
        return { payload: entry["payload"], sequence };
    });
}

export function appendStreamBlock(
    current: readonly StoredSessionStreamEvent[],
    next: StoredSessionStreamEvent,
): AppendedSessionStreamBlock {
    const payload = JSON.stringify([...current, next]);
    return { entryIndex: current.length, payload };
}

export function sessionDeltaText(payload: string): string {
    let value: unknown;
    try {
        value = JSON.parse(payload);
    } catch (cause) {
        throw new DatabaseError("database_statement_invalid", "The session message delta is invalid", { cause });
    }
    if (!isRecord(value) || value["kind"] !== "agent.message.delta" || typeof value["text"] !== "string") {
        throw new DatabaseError("database_statement_invalid", "The session message delta is invalid");
    }
    return value["text"];
}
