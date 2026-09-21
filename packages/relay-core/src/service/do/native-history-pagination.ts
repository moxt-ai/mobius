import type { NativeSessionHistory, NativeSessionHistoryPage } from "@moxt-ai/mobius-protocol";
import { type ProjectScope, SessionRuntimeError } from "../../entity/do/session.ts";

const MAXIMUM_PAGE_SIZE = 100;

interface NativeHistoryCursor {
    readonly endIndex: number;
    readonly projectId: string;
    readonly sessionId: string;
}

interface CoveredTurnRange {
    readonly assistantEndIndex: number;
    readonly assistantStartIndex: number;
    readonly commandId: string;
    readonly userIndex: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeCursor(scope: ProjectScope, sessionId: string, endIndex: number): string {
    return btoa(JSON.stringify({ endIndex, projectId: scope.projectId, sessionId }))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
}

function decodeCursor(encoded: string, scope: ProjectScope, sessionId: string): NativeHistoryCursor {
    try {
        if (!/^[A-Za-z0-9_-]{1,512}$/u.test(encoded)) {
            throw new Error("Invalid cursor alphabet");
        }
        const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
        const padding = (4 - (base64.length % 4)) % 4;
        const value: unknown = JSON.parse(atob(base64 + "=".repeat(padding)));
        if (!isRecord(value) || Object.keys(value).length !== 3) {
            throw new Error("Invalid cursor shape");
        }
        if (
            value["projectId"] !== scope.projectId ||
            value["sessionId"] !== sessionId ||
            typeof value["endIndex"] !== "number" ||
            !Number.isSafeInteger(value["endIndex"]) ||
            value["endIndex"] < 0
        ) {
            throw new Error("Invalid cursor target");
        }
        return {
            endIndex: value["endIndex"],
            projectId: scope.projectId,
            sessionId,
        };
    } catch (cause) {
        throw new SessionRuntimeError("invalid_cursor", "The native Session history cursor is invalid", { cause });
    }
}

function coveredTurnRanges(history: Extract<NativeSessionHistory, { readonly status: "available" }>) {
    const ranges: CoveredTurnRange[] = [];
    let historyIndex = history.messages.length;
    for (const commandId of history.coveredCommandIds) {
        let assistantStartIndex = historyIndex;
        while (assistantStartIndex > 0 && history.messages[assistantStartIndex - 1]?.role === "assistant") {
            assistantStartIndex -= 1;
        }
        const userIndex = assistantStartIndex - 1;
        if (assistantStartIndex === historyIndex || history.messages[userIndex]?.role !== "user") {
            break;
        }
        ranges.push({
            assistantEndIndex: historyIndex,
            assistantStartIndex,
            commandId,
            userIndex,
        });
        historyIndex = userIndex;
    }
    return ranges;
}

export function paginateNativeSessionHistory(
    history: NativeSessionHistory,
    scope: ProjectScope,
    sessionId: string,
    cursor: string | null,
    limit: number,
): NativeSessionHistoryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_PAGE_SIZE) {
        throw new SessionRuntimeError(
            "invalid_page_size",
            `The page size must be between 1 and ${MAXIMUM_PAGE_SIZE.toString()}`,
        );
    }
    if (history.status === "unavailable") {
        if (cursor !== null) {
            throw new SessionRuntimeError("invalid_cursor", "Unavailable native Session history has no cursor");
        }
        return { nextCursor: null, status: "unavailable" };
    }
    const endIndex = cursor === null ? history.messages.length : decodeCursor(cursor, scope, sessionId).endIndex;
    if (endIndex > history.messages.length) {
        throw new SessionRuntimeError("invalid_cursor", "The native Session history cursor is invalid");
    }
    const startIndex = Math.max(0, endIndex - limit);
    const coveredMessageIds = new Set(history.coveredMessageIds);
    const ranges = coveredTurnRanges(history);
    return {
        coveredCommandIds: ranges
            .filter((range) => range.userIndex >= startIndex && range.assistantEndIndex <= endIndex)
            .map((range) => range.commandId),
        coveredMessageIds: ranges.flatMap((range) => [
            ...(range.userIndex >= startIndex &&
            range.userIndex < endIndex &&
            coveredMessageIds.has(`${range.commandId}:user`)
                ? [`${range.commandId}:user`]
                : []),
            ...(range.assistantStartIndex >= startIndex &&
            range.assistantEndIndex <= endIndex &&
            coveredMessageIds.has(`${range.commandId}:agent`)
                ? [`${range.commandId}:agent`]
                : []),
        ]),
        messages: history.messages.slice(startIndex, endIndex),
        nextCursor: startIndex > 0 ? encodeCursor(scope, sessionId, startIndex) : null,
        status: "available",
        truncated: history.truncated,
    };
}
