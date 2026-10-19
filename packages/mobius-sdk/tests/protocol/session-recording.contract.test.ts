import {
    decodeSessionRecordingHistory,
    decodeSessionRecordingTurnItemPage,
    decodeSessionRecordingTurnPage,
    SESSION_RECORDING_TURN_ITEM_PAGE_MAX_LIMIT,
    SESSION_RECORDING_TURN_PAGE_MAX_LIMIT,
} from "@moxt-ai/mobius-sdk/protocol";
import { describe, expect, it } from "vitest";

// One event past the retired history limit, to prove the boundary no longer exists.
const HISTORY_EVENT_COUNT = 100_001;

function historyEvent(index: number) {
    return {
        eventId: `history-event-${index}`,
        position: String(index),
        provenance: { kind: "original" },
        recordedAt: "2026-10-14T00:00:00.000Z",
        sessionGenerationId: "session-generation-history",
        sessionId: "session-history",
        type: "acp",
        payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
    };
}

describe("Session Recording history contracts", () => {
    it("Given a Session longer than the retired event limit, When its full history crosses the protocol boundary, Then every event is delivered", () => {
        const events = Array.from({ length: HISTORY_EVENT_COUNT }, (_, index) => historyEvent(index));
        const encoded = JSON.stringify({ events, sessionId: "session-history" });

        expect(decodeSessionRecordingHistory(encoded).events).toHaveLength(HISTORY_EVENT_COUNT);
    });
});

// One element past what a caller may request from each page, so the boundary proved here is the one
// a decoder applies rather than the one a request validates. A page listing this many must still
// decode: the request bound is a contract on a service, not a limit on what a client can read.
const TURN_COUNT = SESSION_RECORDING_TURN_PAGE_MAX_LIMIT + 1;
const ITEM_COUNT = SESSION_RECORDING_TURN_ITEM_PAGE_MAX_LIMIT + 1;

function turnItem(index: number) {
    return {
        itemId: `turn-item-${index}`,
        kind: "answer",
        omittedCharacters: 0,
        sequence: index,
        text: "",
    };
}

function turn(commandId: string, order: number, items: readonly unknown[]) {
    return {
        answerLength: 0,
        attempt: { kind: "none" },
        commandId,
        createdAt: "2026-10-14T00:00:00.000Z",
        generationId: "session-generation-turns",
        itemCount: items.length,
        items,
        itemsCursor: null,
        messageId: null,
        order,
        preceding: null,
        prompt: null,
    };
}

function turnPage(turns: readonly unknown[], sessionId: string) {
    return JSON.stringify({
        activeCommands: null,
        interactions: [],
        nextCursor: null,
        sessionId,
        tailCursor: "v2:1:0",
        title: null,
        turns,
        version: 1,
    });
}

describe("Session Recording Turn page contracts", () => {
    it("Given a page a service lists past the requestable page size, When it is decoded, Then every Turn is delivered", () => {
        const turns = Array.from({ length: TURN_COUNT }, (_, index) =>
            turn(`turn-command-${index}`, index + 1, [turnItem(0)]),
        );

        expect(decodeSessionRecordingTurnPage(turnPage(turns, "session-turns")).turns).toHaveLength(TURN_COUNT);
    });

    it("Given one Turn listing past the requestable item page, When its items are decoded, Then every item is delivered", () => {
        const items = Array.from({ length: ITEM_COUNT }, (_, index) => turnItem(index));
        const encoded = turnPage([turn("turn-command-1", 1, items)], "session-turns");

        expect(decodeSessionRecordingTurnPage(encoded).turns[0]?.items).toHaveLength(ITEM_COUNT);
    });

    it("Given an item page a service lists past the requestable item page, When it is decoded, Then every item is delivered", () => {
        const items = Array.from({ length: ITEM_COUNT }, (_, index) => turnItem(index));
        const encoded = JSON.stringify({
            commandId: "turn-command-1",
            items,
            nextCursor: null,
            sessionId: "session-turns",
            version: 1,
        });

        expect(decodeSessionRecordingTurnItemPage(encoded).items).toHaveLength(ITEM_COUNT);
    });
});
