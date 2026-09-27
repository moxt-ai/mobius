import {
    type NativeMessagePage,
    type NativeSessionHistory,
    type NativeSessionResult,
    SESSION_HISTORY_CHARACTER_LIMIT,
} from "@moxt-ai/mobius-protocol";
import { AcpExecutionError } from "../acp/agent-runtime-manager.ts";

type ActiveTurnSnapshot = Extract<NativeSessionResult, { readonly action: "active-turn" }>["turn"];
type AvailableNativeMessagePage = Extract<NativeMessagePage, { readonly status: "available" }>;
type AvailableNativeSessionHistory = Extract<NativeSessionHistory, { readonly status: "available" }>;
type ActiveAssistantMessage = NonNullable<ActiveTurnSnapshot>["messages"][number];

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
    messages: readonly ActiveAssistantMessage[],
    messageLimit: number,
    characterLimit: number,
): { readonly characters: number; readonly messages: readonly ActiveAssistantMessage[]; readonly truncated: boolean } {
    const selected: ActiveAssistantMessage[] = [];
    let remainingCharacters = characterLimit;
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
        if (selected.length === 0 && structuredCharacters <= remainingCharacters) {
            const textCharacters = remainingCharacters - structuredCharacters;
            selected.unshift({ ...message, text: textCharacters === 0 ? "" : message.text.slice(-textCharacters) });
            remainingCharacters = 0;
        }
        break;
    }
    return {
        characters: characterLimit - remainingCharacters,
        messages: selected,
        truncated: selected.length !== messages.length,
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
            activeTurn.messages,
            Math.max(0, limit - 1),
            Math.max(0, SESSION_HISTORY_CHARACTER_LIMIT - activeTurn.prompt.length),
        );
        return {
            coveredCommandIds: [],
            coveredMessageIds: [],
            messages: [{ role: "user", text: activeTurn.prompt }, ...bounded.messages],
            nextCursor: null,
            status: "available",
            truncated: activeTurn.truncated || bounded.truncated,
        };
    }
    // Native turn identity, rather than prompt text, tells us whether the source
    // already contains this turn. Keep its user message (including attachments),
    // and replace its partial assistant output with the current memory snapshot.
    const activeUserIndex = history.coveredCommandIds.includes(activeTurn.commandId)
        ? history.messages.findLastIndex((message) => message.role === "user")
        : -1;
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
    const includeActivePrompt =
        activeUserIndex < 0 &&
        !(latestNativeMessage?.role === "user" && latestNativeMessage.text === activeTurn.prompt);
    const bounded = boundedActiveMessages(
        activeTurn.messages,
        Math.max(0, limit - (includeActivePrompt ? 1 : 0)),
        Math.max(0, SESSION_HISTORY_CHARACTER_LIMIT - (includeActivePrompt ? activeTurn.prompt.length : 0)),
    );
    const activeMessages = [
        ...(includeActivePrompt ? [{ role: "user" as const, text: activeTurn.prompt }] : []),
        ...bounded.messages,
    ];

    let historicalMessageCount = 0;
    let remainingCharacters =
        SESSION_HISTORY_CHARACTER_LIMIT - bounded.characters - (includeActivePrompt ? activeTurn.prompt.length : 0);
    const historicalMessageLimit = Math.max(0, limit - activeMessages.length);
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
        messages: [...page.messages, ...activeMessages],
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
