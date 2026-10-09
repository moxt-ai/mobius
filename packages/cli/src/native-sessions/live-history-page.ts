import {
    type NativeHistoryImage,
    type NativeHistoryMessage,
    type NativeMessagePage,
    type NativeSessionHistory,
    SESSION_HISTORY_CHARACTER_LIMIT,
} from "@moxt-ai/mobius-protocol";
import { AcpExecutionError } from "../acp/agent-runtime-manager.ts";
import type { ActiveTurnRecovery } from "../daemon-active-turn.ts";

type AvailableNativeMessagePage = Extract<NativeMessagePage, { readonly status: "available" }>;
type AvailableNativeSessionHistory = Extract<NativeSessionHistory, { readonly status: "available" }>;
type ActiveTurnMessage = ActiveTurnRecovery["messages"][number];

interface LiveHistoryCoveredTurnRange {
    readonly assistantEndIndex: number;
    readonly assistantStartIndex: number;
    readonly commandId: string;
    readonly userIndex: number;
}

type LiveHistoryCursor =
    | {
          readonly endIndex: number;
          readonly kind: "active";
          readonly epoch: string;
          readonly sessionId: string;
      }
    | { readonly endIndex: number; readonly kind: "native"; readonly sessionId: string };

function encodeLiveHistoryCursor(cursor: LiveHistoryCursor): string {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeLiveHistoryCursor(cursor: string, sessionId: string): LiveHistoryCursor {
    try {
        if (!/^[A-Za-z0-9_-]{1,512}$/u.test(cursor)) {
            throw new Error("Invalid cursor alphabet");
        }
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("Invalid cursor shape");
        }
        const record = Object.fromEntries(Object.entries(value));
        const keys = Object.keys(record).sort().join(",");
        const legacyNative = keys === "endIndex,sessionId";
        const kind = legacyNative ? "native" : record["kind"];
        if (
            (keys !== "endIndex,kind,sessionId" && keys !== "endIndex,epoch,kind,sessionId" && !legacyNative) ||
            record["sessionId"] !== sessionId ||
            (kind !== "active" && kind !== "native") ||
            typeof record["endIndex"] !== "number" ||
            !Number.isSafeInteger(record["endIndex"]) ||
            record["endIndex"] < 0
        ) {
            throw new Error("Invalid cursor target");
        }
        if (kind === "active") {
            if (keys !== "endIndex,epoch,kind,sessionId" || typeof record["epoch"] !== "string") {
                throw new Error("Invalid active cursor target");
            }
            return { endIndex: record["endIndex"], epoch: record["epoch"], kind, sessionId };
        }
        if (keys !== "endIndex,kind,sessionId" && !legacyNative) {
            throw new Error("Invalid native cursor target");
        }
        return { endIndex: record["endIndex"], kind, sessionId };
    } catch (cause) {
        throw new AcpExecutionError("The native Session history cursor is invalid", { cause }, "invalid_cursor");
    }
}

function activeHistoryCursor(sessionId: string, epoch: string, endIndex: number): string {
    return encodeLiveHistoryCursor({ endIndex, epoch, kind: "active", sessionId });
}

function nativeHistoryCursor(sessionId: string, endIndex: number): string {
    return encodeLiveHistoryCursor({ endIndex, kind: "native", sessionId });
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

function historyMessageCharacters(message: NativeHistoryMessage): number {
    return (
        message.text.length +
        (message.role === "assistant"
            ? JSON.stringify(message.activities).length + JSON.stringify(message.content).length
            : 0)
    );
}

function isNativeHistoryImageMimeType(mimeType: string): mimeType is NativeHistoryImage["mimeType"] {
    return (
        mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/gif" || mimeType === "image/webp"
    );
}

function selectMessagesBefore(
    messages: readonly NativeHistoryMessage[],
    endIndex: number,
    messageLimit: number,
    characterLimit: number,
): { readonly characters: number; readonly messages: readonly NativeHistoryMessage[]; readonly startIndex: number } {
    const selected: NativeHistoryMessage[] = [];
    let remainingCharacters = characterLimit;
    let startIndex = endIndex;
    for (let index = endIndex - 1; index >= 0 && selected.length < messageLimit; index -= 1) {
        const message = messages[index];
        if (message === undefined) {
            break;
        }
        const characters = historyMessageCharacters(message);
        if (characters > remainingCharacters) {
            break;
        }
        selected.unshift(message);
        remainingCharacters -= characters;
        startIndex = index;
    }
    if (selected.length === 0 && endIndex > 0) {
        throw new AcpExecutionError(
            "A native Session history item exceeds the page budget",
            {},
            "history_item_too_large",
        );
    }
    return { characters: characterLimit - remainingCharacters, messages: selected, startIndex };
}

function nativeActiveMessage(message: ActiveTurnMessage): NativeHistoryMessage {
    if (message.role === "assistant") {
        return {
            activities: message.activities,
            content: message.content,
            role: "assistant",
            text: message.text,
        };
    }
    const images = (message.images ?? []).flatMap((image) => {
        if (
            image.data.length < 4 ||
            image.data.length % 4 !== 0 ||
            !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data) ||
            !isNativeHistoryImageMimeType(image.mimeType)
        ) {
            return [];
        }
        return [{ data: image.data, mimeType: image.mimeType, name: image.name }];
    });
    return { ...(images.length === 0 ? {} : { images }), role: "user", text: message.text };
}

function nativeHistoryCoversCompletedRecovery(
    history: AvailableNativeSessionHistory,
    recovery: Extract<ActiveTurnRecovery, { readonly state: "completed" }>,
): boolean {
    const root = recovery.messages.find((message) => message.role === "user" && message.id === recovery.commandId);
    if (root === undefined) {
        return false;
    }
    const rootIndex = history.messages.findLastIndex(
        (message) => message.role === "user" && message.text === root.text,
    );
    if (rootIndex < 0) {
        return false;
    }
    const nativeAssistant = history.messages.slice(rootIndex + 1).filter((message) => message.role === "assistant");
    if (nativeAssistant.length === 0) {
        return false;
    }
    const recoveryAssistant = recovery.messages.filter((message) => message.role === "assistant");
    const recoveryText = recoveryAssistant.map((message) => message.text).join("");
    const nativeText = nativeAssistant.map((message) => message.text).join("");
    if (recoveryText.length > 0 && !nativeText.includes(recoveryText)) {
        return false;
    }
    const nativeContent = new Set(
        nativeAssistant.flatMap((message) => message.content).map((content) => JSON.stringify(content)),
    );
    return recoveryAssistant
        .flatMap((message) => message.content)
        .every((content) => nativeContent.has(JSON.stringify(content)));
}

function historyBeforeActiveTurn(history: NativeSessionHistory, activeTurn: ActiveTurnRecovery): NativeSessionHistory {
    if (history.status === "unavailable") {
        return history;
    }
    const activeRoot = activeTurn.messages.find(
        (message) => message.role === "user" && message.id === activeTurn.commandId,
    );
    const matchingActiveUserIndex =
        activeRoot === undefined
            ? -1
            : activeTurn.state === "completed" ||
                (history.messages.at(-1)?.role === "user" && history.messages.at(-1)?.text === activeRoot.text) ||
                history.coveredCommandIds.includes(activeTurn.commandId)
              ? history.messages.findLastIndex((message) => message.role === "user" && message.text === activeRoot.text)
              : -1;
    const activeUserIndex =
        matchingActiveUserIndex >= 0
            ? matchingActiveUserIndex
            : (liveHistoryCoveredTurnRanges(history).find((range) => range.commandId === activeTurn.commandId)
                  ?.userIndex ?? -1);
    if (activeUserIndex < 0) {
        return history;
    }
    return {
        ...history,
        coveredCommandIds: history.coveredCommandIds.filter((id) => id !== activeTurn.commandId),
        coveredMessageIds: history.coveredMessageIds.filter(
            (id) => id !== `${activeTurn.commandId}:user` && id !== `${activeTurn.commandId}:agent`,
        ),
        messages: history.messages.slice(0, activeUserIndex),
    };
}

function paginateAvailableNativeHistory(
    history: AvailableNativeSessionHistory,
    sessionId: string,
    endIndex: number,
    limit: number,
    characterLimit: number,
): AvailableNativeMessagePage {
    if (endIndex > history.messages.length) {
        throw new AcpExecutionError("The native Session history cursor is invalid", {}, "invalid_cursor");
    }
    const selected = selectMessagesBefore(history.messages, endIndex, limit, characterLimit);
    const coveredMessageIds = new Set(history.coveredMessageIds);
    const ranges = liveHistoryCoveredTurnRanges(history);
    return {
        coveredCommandIds: ranges
            .filter((range) => range.userIndex >= selected.startIndex && range.assistantEndIndex <= endIndex)
            .map((range) => range.commandId),
        coveredMessageIds: ranges.flatMap((range) => [
            ...(range.userIndex >= selected.startIndex &&
            range.userIndex < endIndex &&
            coveredMessageIds.has(`${range.commandId}:user`)
                ? [`${range.commandId}:user`]
                : []),
            ...(range.assistantStartIndex >= selected.startIndex &&
            range.assistantEndIndex <= endIndex &&
            coveredMessageIds.has(`${range.commandId}:agent`)
                ? [`${range.commandId}:agent`]
                : []),
        ]),
        messages: selected.messages,
        nextCursor: selected.startIndex > 0 ? nativeHistoryCursor(sessionId, selected.startIndex) : null,
        status: "available",
        truncated: history.truncated,
    };
}

function paginateNativeHistory(
    history: NativeSessionHistory,
    sessionId: string,
    cursor: LiveHistoryCursor | null,
    limit: number,
): NativeMessagePage {
    if (cursor?.kind === "active") {
        throw new AcpExecutionError("The native Session history cursor is invalid", {}, "invalid_cursor");
    }
    if (history.status === "unavailable") {
        if (cursor !== null) {
            throw new AcpExecutionError("Unavailable native Session history has no cursor", {}, "invalid_cursor");
        }
        return { cause: history.cause, nextCursor: null, status: "unavailable" };
    }
    return paginateAvailableNativeHistory(
        history,
        sessionId,
        cursor?.endIndex ?? history.messages.length,
        limit,
        SESSION_HISTORY_CHARACTER_LIMIT,
    );
}

function paginateActiveTurn(
    history: NativeSessionHistory,
    activeTurn: ActiveTurnRecovery,
    sessionId: string,
    endIndex: number,
    limit: number,
): AvailableNativeMessagePage {
    if (endIndex > activeTurn.messages.length) {
        throw new AcpExecutionError("The native Session history cursor is invalid", {}, "invalid_cursor");
    }
    const activeMessages = activeTurn.messages.map(nativeActiveMessage);
    const active = selectMessagesBefore(activeMessages, endIndex, limit, SESSION_HISTORY_CHARACTER_LIMIT);
    const historicalLimit = limit - active.messages.length;
    const historicalCharacterLimit = SESSION_HISTORY_CHARACTER_LIMIT - active.characters;
    const pendingHistoricalCursor =
        history.status === "available" && history.messages.length > 0
            ? nativeHistoryCursor(sessionId, history.messages.length)
            : null;
    const latestHistoricalMessage = history.status === "available" ? history.messages.at(-1) : undefined;
    const historicalPageFits =
        latestHistoricalMessage === undefined ||
        historyMessageCharacters(latestHistoricalMessage) <= historicalCharacterLimit;
    const historical =
        active.startIndex === 0 && history.status === "available" && historicalLimit > 0 && historicalPageFits
            ? paginateAvailableNativeHistory(
                  history,
                  sessionId,
                  history.messages.length,
                  historicalLimit,
                  historicalCharacterLimit,
              )
            : null;
    return {
        streamPosition: { commandId: activeTurn.commandId, epoch: activeTurn.epoch, sequence: activeTurn.sequence },
        coveredCommandIds: historical?.coveredCommandIds ?? [],
        coveredMessageIds: [
            ...(historical?.coveredMessageIds ?? []),
            ...(active.startIndex === 0 ? [`${activeTurn.commandId}:user`, `${activeTurn.commandId}:agent`] : []),
        ],
        messages: [...(historical?.messages ?? []), ...active.messages],
        nextCursor:
            active.startIndex > 0
                ? activeHistoryCursor(sessionId, activeTurn.epoch, active.startIndex)
                : historical === null
                  ? pendingHistoricalCursor
                  : historical.nextCursor,
        status: "available",
        truncated: activeTurn.truncated || (historical?.truncated ?? false),
    };
}

export function paginateLiveSessionHistory(
    history: NativeSessionHistory,
    activeTurn: ActiveTurnRecovery | null,
    sessionId: string,
    encodedCursor: string | null,
    limit: number,
): NativeMessagePage {
    const cursor = encodedCursor === null ? null : decodeLiveHistoryCursor(encodedCursor, sessionId);
    if (
        activeTurn === null ||
        (activeTurn.state === "completed" &&
            history.status === "available" &&
            nativeHistoryCoversCompletedRecovery(history, activeTurn))
    ) {
        return paginateNativeHistory(history, sessionId, cursor, limit);
    }
    const historical = historyBeforeActiveTurn(history, activeTurn);
    if (cursor?.kind === "native") {
        return paginateNativeHistory(historical, sessionId, cursor, limit);
    }
    if (cursor !== null && cursor.epoch !== activeTurn.epoch) {
        throw new AcpExecutionError("The active Turn history cursor is stale", {}, "stale_cursor");
    }
    return paginateActiveTurn(historical, activeTurn, sessionId, cursor?.endIndex ?? activeTurn.messages.length, limit);
}
