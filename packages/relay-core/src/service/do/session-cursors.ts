import { type ProjectScope, SessionRuntimeError } from "../../entity/do/session.ts";
import { hasExactKeys, isRecord } from "./session-codec.ts";
export interface EventCursor {
    readonly projectId: string;
    readonly sequence: number;
    readonly sessionId: string;
    readonly tenantId: string;
}

export interface MessageCursor {
    readonly commandId: string;
    readonly createdAt: number;
    readonly projectId: string;
    readonly sessionId: string;
    readonly tenantId: string;
}

export interface DirectoryCursor {
    readonly projectId: string;
    readonly sessionId: string;
    readonly tenantId: string;
    readonly updatedAt: number;
}

export function encodeCursor(value: EventCursor | MessageCursor | DirectoryCursor): string {
    return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(encoded: string): Readonly<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(encoded)) {
        throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid");
    }
    try {
        const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
        const padding = "=".repeat((4 - (base64.length % 4)) % 4);
        const value: unknown = JSON.parse(atob(`${base64}${padding}`));
        if (!isRecord(value)) {
            throw new Error("Cursor must be an object");
        }
        return value;
    } catch (cause) {
        throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid", {
            cause,
        });
    }
}

export function decodeEventCursor(encoded: string, scope: ProjectScope, sessionId: string): EventCursor {
    const value = decodeCursor(encoded);
    const sequence = value["sequence"];
    if (
        !hasExactKeys(value, ["projectId", "sequence", "sessionId", "tenantId"]) ||
        value["tenantId"] !== scope["tenantId"] ||
        value["projectId"] !== scope["projectId"] ||
        value["sessionId"] !== sessionId ||
        typeof sequence !== "number" ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0
    ) {
        throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid");
    }
    return {
        projectId: scope.projectId,
        sequence,
        sessionId,
        tenantId: scope.tenantId,
    };
}

export function decodeMessageCursor(encoded: string, scope: ProjectScope, sessionId: string): MessageCursor {
    const value = decodeCursor(encoded);
    const commandId = value["commandId"];
    const createdAt = value["createdAt"];
    if (
        !hasExactKeys(value, ["commandId", "createdAt", "projectId", "sessionId", "tenantId"]) ||
        value["tenantId"] !== scope["tenantId"] ||
        value["projectId"] !== scope["projectId"] ||
        value["sessionId"] !== sessionId ||
        typeof commandId !== "string" ||
        typeof createdAt !== "number" ||
        !Number.isSafeInteger(createdAt) ||
        createdAt < 0
    ) {
        throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid");
    }
    return {
        commandId,
        createdAt,
        projectId: scope.projectId,
        sessionId,
        tenantId: scope.tenantId,
    };
}

export function decodeDirectoryCursor(encoded: string, scope: ProjectScope): DirectoryCursor {
    const value = decodeCursor(encoded);
    const sessionId = value["sessionId"];
    const updatedAt = value["updatedAt"];
    if (
        !hasExactKeys(value, ["projectId", "sessionId", "tenantId", "updatedAt"]) ||
        value["tenantId"] !== scope["tenantId"] ||
        value["projectId"] !== scope["projectId"] ||
        typeof sessionId !== "string" ||
        typeof updatedAt !== "number" ||
        !Number.isSafeInteger(updatedAt) ||
        updatedAt < 0
    ) {
        throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid");
    }
    return {
        projectId: scope.projectId,
        sessionId,
        tenantId: scope.tenantId,
        updatedAt,
    };
}
