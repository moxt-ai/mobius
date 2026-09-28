import {
    type NativeHistoryMessage,
    type NativeMessagePage,
    type NativeSessionHistory,
    type NativeSessionResult,
    SESSION_HISTORY_CHARACTER_LIMIT,
} from "@moxt-ai/mobius-protocol";
import { AcpExecutionError } from "../acp/agent-runtime-manager.ts";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];
type AvailableNativeMessagePage = Extract<NativeMessagePage, { readonly status: "available" }>;
type AvailableNativeSessionHistory = Extract<NativeSessionHistory, { readonly status: "available" }>;
type ActiveTurnMessage = NonNullable<ActiveTurnSnapshot>["messages"][number];

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

function liveHistoryCoveredTurnRanges(history: AvailableNativeSessionHistory): readonly LiveHistoryCoveredTurnRange[] {
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

function historyMessageCharacters(message: AvailableNativeSessionHistory["messages"][number]): number {
    return (
        message.text.length +
        (message.role === "assistant"
            ? JSON.stringify(message.activities).length + JSON.stringify(message.content).length
            : 0)
    );
}

function boundedActiveMessages(
    messages: readonly NativeHistoryMessage[],
    messageLimit: number,
    characterLimit: number,
): { readonly characters: number; readonly messages: readonly NativeHistoryMessage[]; readonly truncated: boolean } {
    const selected: NativeHistoryMessage[] = [];
    let remainingCharacters = characterLimit;
    let truncated = false;
    for (let index = messages.length - 1; index >= 0 && selected.length < messageLimit; index -= 1) {
        const message = messages[index];
        if (message === undefined) {
            break;
        }
        const characters = historyMessageCharacters(message);
        if (characters <= remainingCharacters) {
            selected.unshift(message);
            remainingCharacters -= characters;
            continue;
        }
        const structuredCharacters = characters - message.text.length;
        if (structuredCharacters <= remainingCharacters) {
            const textCharacters = remainingCharacters - structuredCharacters;
            selected.unshift({ ...message, text: textCharacters === 0 ? "" : message.text.slice(-textCharacters) });
            remainingCharacters = 0;
            truncated = true;
        }
        break;
    }
    return {
        characters: characterLimit - remainingCharacters,
        messages: selected,
        truncated: truncated || selected.length !== messages.length,
    };
}

function nativeActiveMessage(message: ActiveTurnMessage): NativeHistoryMessage {
    return message.role === "user"
        ? { role: "user", text: message.text }
        : {
              activities: message.activities,
              content: message.content,
              role: "assistant",
              text: message.text,
          };
}

function paginateAcpSessionHistory(
    history: AvailableNativeSessionHistory,
    sessionId: string,
    cursor: string | null,
    limit: number,
): AvailableNativeMessagePage;
function paginateAcpSessionHistory(
    history: NativeSessionHistory,
    sessionId: string,
    cursor: string | null,
    limit: number,
): NativeMessagePage;
function paginateAcpSessionHistory(
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

export function paginateLiveSessionHistory(
    history: NativeSessionHistory,
    activeTurn: ActiveTurnSnapshot,
    sessionId: string,
    cursor: string | null,
    limit: number,
): NativeMessagePage {
    if (activeTurn === null || cursor !== null) {
        return paginateAcpSessionHistory(history, sessionId, cursor, limit);
    }

    if (history.status === "unavailable") {
        const bounded = boundedActiveMessages(
            activeTurn.messages.map(nativeActiveMessage),
            limit,
            SESSION_HISTORY_CHARACTER_LIMIT,
        );
        return {
            coveredCommandIds: [],
            coveredMessageIds: [],
            messages: bounded.messages,
            nextCursor: null,
            status: "available",
            truncated: activeTurn.truncated || bounded.truncated,
        };
    }
    // Native turn identity tells us whether the source contains this turn. The
    // native format has no message IDs, so its root prompt locates the boundary
    // before any steering prompts. Keep that root (including attachments), then
    // replace the rest with the authoritative in-memory timeline.
    const activeRoot = activeTurn.messages.find(
        (message) => message.role === "user" && message.id === activeTurn.commandId,
    );
    const coveredActiveRoot = history.coveredCommandIds.includes(activeTurn.commandId);
    const matchingActiveUserIndex =
        coveredActiveRoot && activeRoot !== undefined
            ? history.messages.findLastIndex((message) => message.role === "user" && message.text === activeRoot.text)
            : -1;
    const activeUserIndex =
        matchingActiveUserIndex >= 0
            ? matchingActiveUserIndex
            : (liveHistoryCoveredTurnRanges(history).find((range) => range.commandId === activeTurn.commandId)
                  ?.userIndex ?? -1);
    if (activeUserIndex >= 0) {
        history = {
            ...history,
            coveredCommandIds: history.coveredCommandIds.filter((id) => id !== activeTurn.commandId),
            coveredMessageIds: history.coveredMessageIds.filter(
                (id) => id !== `${activeTurn.commandId}:user` && id !== `${activeTurn.commandId}:agent`,
            ),
            messages: history.messages.slice(0, activeUserIndex + 1),
        };
    }
    const latestNativeMessage = history.messages.at(-1);
    const firstActiveMessage = activeTurn.messages[0];
    const preserveNativeRoot =
        activeUserIndex >= 0 ||
        (firstActiveMessage?.role === "user" &&
            latestNativeMessage?.role === "user" &&
            latestNativeMessage.text === firstActiveMessage.text);
    const activeMessages = activeTurn.messages.slice(preserveNativeRoot ? 1 : 0).map(nativeActiveMessage);
    const bounded = boundedActiveMessages(activeMessages, limit, SESSION_HISTORY_CHARACTER_LIMIT);

    let historicalMessageCount = 0;
    let remainingCharacters = SESSION_HISTORY_CHARACTER_LIMIT - bounded.characters;
    const historicalMessageLimit = Math.max(0, limit - bounded.messages.length);
    for (
        let index = history.messages.length - 1;
        index >= 0 && historicalMessageCount < historicalMessageLimit;
        index -= 1
    ) {
        const message = history.messages[index];
        if (message === undefined) {
            break;
        }
        const characters = historyMessageCharacters(message);
        if (characters > remainingCharacters) {
            break;
        }
        historicalMessageCount += 1;
        remainingCharacters -= characters;
    }
    const page =
        historicalMessageCount === 0
            ? {
                  coveredCommandIds: [],
                  coveredMessageIds: [],
                  messages: [],
                  nextCursor:
                      history.messages.length === 0 ? null : liveHistoryCursor(sessionId, history.messages.length),
                  status: "available" as const,
                  truncated: history.truncated,
              }
            : paginateAcpSessionHistory(history, sessionId, null, historicalMessageCount);
    return {
        ...page,
        messages: [...page.messages, ...bounded.messages],
        truncated: page.truncated || activeTurn.truncated || bounded.truncated,
    };
}

export function mergeLiveSessionHistory(
    history: NativeSessionHistory,
    activeTurn: ActiveTurnSnapshot,
    sessionId: string,
): NativeSessionHistory {
    const page = paginateLiveSessionHistory(history, activeTurn, sessionId, null, 1_000);
    if (page.status === "unavailable") {
        return { cause: page.cause, status: "unavailable" };
    }
    return {
        coveredCommandIds: page.coveredCommandIds,
        coveredMessageIds: page.coveredMessageIds,
        messages: page.messages,
        status: "available",
        truncated: page.truncated,
    };
}
