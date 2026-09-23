import type { NativeMessagePage, NativeSessionHistory } from "@moxt-ai/mobius-protocol";
import { AcpExecutionError } from "../acp/session-manager.ts";

interface LiveHistoryCoveredTurnRange {
    readonly assistantEndIndex: number;
    readonly assistantStartIndex: number;
    readonly commandId: string;
    readonly userIndex: number;
}

function liveHistoryCursor(sessionId: string, endIndex: number): string {
    return Buffer.from(JSON.stringify({ endIndex, sessionId }), "utf8").toString("base64url");
}

function liveHistoryEndIndex(cursor: string, sessionId: string): number {
    try {
        if (!/^[A-Za-z0-9_-]{1,512}$/u.test(cursor)) {
            throw new Error("Invalid cursor alphabet");
        }
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("Invalid cursor shape");
        }
        const record = Object.fromEntries(Object.entries(value));
        if (
            Object.keys(record).sort().join(",") !== "endIndex,sessionId" ||
            record["sessionId"] !== sessionId ||
            typeof record["endIndex"] !== "number" ||
            !Number.isSafeInteger(record["endIndex"]) ||
            record["endIndex"] < 0
        ) {
            throw new Error("Invalid cursor target");
        }
        return record["endIndex"];
    } catch (cause) {
        throw new AcpExecutionError("The native Session history cursor is invalid", { cause }, "invalid_cursor");
    }
}

function liveHistoryCoveredTurnRanges(
    history: Extract<NativeSessionHistory, { readonly status: "available" }>,
): readonly LiveHistoryCoveredTurnRange[] {
    const ranges: LiveHistoryCoveredTurnRange[] = [];
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
        ranges.push({ assistantEndIndex: historyIndex, assistantStartIndex, commandId, userIndex });
        historyIndex = userIndex;
    }
    return ranges;
}

export function paginateLiveSessionHistory(
    history: NativeSessionHistory,
    sessionId: string,
    cursor: string | null,
    limit: number,
): NativeMessagePage {
    if (history.status === "unavailable") {
        if (cursor !== null) {
            throw new AcpExecutionError("Unavailable native Session history has no cursor", {}, "invalid_cursor");
        }
        return { cause: history.cause, nextCursor: null, status: "unavailable" };
    }
    const endIndex = cursor === null ? history.messages.length : liveHistoryEndIndex(cursor, sessionId);
    if (endIndex > history.messages.length) {
        throw new AcpExecutionError("The native Session history cursor is invalid", {}, "invalid_cursor");
    }
    const startIndex = Math.max(0, endIndex - limit);
    const coveredMessageIds = new Set(history.coveredMessageIds);
    const ranges = liveHistoryCoveredTurnRanges(history);
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
        nextCursor: startIndex > 0 ? liveHistoryCursor(sessionId, startIndex) : null,
        status: "available",
        truncated: history.truncated,
    };
}
