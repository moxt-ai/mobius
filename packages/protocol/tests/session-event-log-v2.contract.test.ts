import { describe, expect, it } from "vitest";

import {
    type AcpSessionUpdateV2,
    decodeMobiusSessionExportV2,
    decodeNativeSessionEventsV2,
    decodeSessionEventLogPageV2,
    encodeMobiusSessionExportV2,
    encodeNativeSessionEventsV2,
    encodeSessionEventLogPageV2,
    ProtocolMessageError,
    type SessionEventV2,
} from "../src/index.ts";

const recordedAt = "2026-10-06T00:00:00.000Z";

function event(position: number, update: AcpSessionUpdateV2): SessionEventV2 {
    return {
        eventId: `event-${position}`,
        payload: update,
        position: position.toString(),
        provenance: { kind: "original" },
        recordedAt,
        sessionId: "session-1",
        type: "acp",
    };
}

describe("Session Event Log V2 protocol", () => {
    it("Given a bounded committed V2 log, When it is exported across the public boundary, Then binding metadata, raw events, and provenance round-trip", () => {
        const imported = {
            ...event(1, {
                content: { text: "copied", type: "text" },
                messageId: "message-1",
                sessionUpdate: "agent_message_chunk",
            }),
            provenance: {
                kind: "imported",
                sourceEventId: "source-event-1",
                sourcePosition: "7",
                sourceSessionId: "source-session",
            },
        } as const;
        const exported = {
            formatVersion: "2",
            session: {
                binding: { bindingId: "binding-1", runtimeId: "runtime-1" },
                events: [imported],
                sessionId: "session-1",
                truncated: false,
            },
        } as const;

        expect(decodeMobiusSessionExportV2(encodeMobiusSessionExportV2(exported))).toEqual(exported);
    });

    it("Given a V2 export repeats an event identity or changes Session scope, When it crosses the import boundary, Then the malformed log is rejected", () => {
        const source = event(1, {
            content: { text: "source", type: "text" },
            messageId: "message-1",
            sessionUpdate: "agent_message_chunk",
        });
        for (const events of [
            [source, { ...source, position: "2" }],
            [source, { ...source, eventId: "event-2", position: "2", sessionId: "other-session" }],
        ]) {
            expect(() =>
                decodeMobiusSessionExportV2({
                    formatVersion: "2",
                    session: {
                        binding: { bindingId: "binding-1", runtimeId: "runtime-1" },
                        events,
                        sessionId: "session-1",
                        truncated: false,
                    },
                }),
            ).toThrow(ProtocolMessageError);
        }
    });

    it("Given ACP emits every supported update variant, When the V2 page crosses the boundary, Then each raw update and source identity round-trips in order", () => {
        const updates = [
            {
                content: { text: "question", type: "text" },
                messageId: "user-message-1",
                sessionUpdate: "user_message_chunk",
            },
            {
                content: { text: "answer", type: "text" },
                messageId: "agent-message-1",
                sessionUpdate: "agent_message_chunk",
            },
            {
                content: { text: "reasoning", type: "text" },
                messageId: "thought-message-1",
                sessionUpdate: "agent_thought_chunk",
            },
            {
                content: [{ content: { text: "reading", type: "text" }, type: "content" }],
                kind: "read",
                locations: [{ line: 4, path: "/workspace/a.ts" }],
                rawInput: { path: "a.ts" },
                sessionUpdate: "tool_call",
                status: "in_progress",
                title: "Read a.ts",
                toolCallId: "tool-1",
            },
            {
                content: [{ content: { text: "done", type: "text" }, type: "content" }],
                rawOutput: { bytes: 12 },
                sessionUpdate: "tool_call_update",
                status: "completed",
                toolCallId: "tool-1",
            },
            {
                entries: [{ content: "Inspect", priority: "high", status: "in_progress" }],
                sessionUpdate: "plan",
            },
            {
                plan: { content: "# Updated", planId: "plan-1", type: "markdown" },
                sessionUpdate: "plan_update",
            },
            { planId: "plan-1", sessionUpdate: "plan_removed" },
            {
                availableCommands: [{ description: "Review files", name: "review" }],
                sessionUpdate: "available_commands_update",
            },
            { currentModeId: "code", sessionUpdate: "current_mode_update" },
            { configOptions: [], sessionUpdate: "config_option_update" },
            { sessionUpdate: "session_info_update", title: "Session title", updatedAt: null },
            {
                cost: { amount: 0.25, currency: "USD" },
                sessionUpdate: "usage_update",
                size: 200_000,
                used: 50_000,
            },
            {
                compactionId: "compaction-1",
                sessionUpdate: "compaction_update",
                status: "in_progress",
                summary: null,
            },
            {
                compactionId: "compaction-1",
                content: { text: "summary", type: "text" },
                sessionUpdate: "compaction_summary_chunk",
            },
        ] as const;
        const page = {
            events: updates.map((update, index) => event(index + 1, update)),
            nextCursor: null,
            tailCursor: "event-15",
            truncated: false,
            version: 2,
        } as const;

        expect(decodeSessionEventLogPageV2(encodeSessionEventLogPageV2(page))).toEqual(page);
    });

    it("Given ACP sends omitted, null, and concrete tool patches, When V2 decodes them, Then field presence remains distinct", () => {
        const page = {
            events: [
                event(1, { sessionUpdate: "tool_call_update", toolCallId: "tool-1" }),
                event(2, { rawOutput: null, sessionUpdate: "tool_call_update", toolCallId: "tool-1" }),
                event(3, {
                    rawOutput: { result: "ok" },
                    sessionUpdate: "tool_call_update",
                    toolCallId: "tool-1",
                }),
            ],
            nextCursor: null,
            tailCursor: "event-3",
            truncated: false,
            version: 2,
        } as const;

        const decoded = decodeSessionEventLogPageV2(encodeSessionEventLogPageV2(page));
        const first = decoded.events[0];
        const second = decoded.events[1];
        const third = decoded.events[2];
        if (
            first?.type !== "acp" ||
            second?.type !== "acp" ||
            third?.type !== "acp" ||
            first.payload.sessionUpdate !== "tool_call_update" ||
            second.payload.sessionUpdate !== "tool_call_update" ||
            third.payload.sessionUpdate !== "tool_call_update"
        ) {
            throw new Error("Expected ACP updates");
        }
        expect(Object.hasOwn(first.payload, "rawOutput")).toBe(false);
        expect(Object.hasOwn(second.payload, "rawOutput")).toBe(true);
        expect(Object.hasOwn(third.payload, "rawOutput")).toBe(true);
        expect(second.payload.rawOutput).toBeNull();
        expect(third.payload.rawOutput).toEqual({ result: "ok" });
    });

    it("Given committed history and an outstanding ACP prompt request, When native recovery crosses the boundary, Then both raw logs remain separate", () => {
        const historyEvent = event(1, {
            content: { text: "committed", type: "text" },
            messageId: "message-1",
            sessionUpdate: "agent_message_chunk",
        });
        const executingEvent = event(2, {
            content: { text: "in flight", type: "text" },
            messageId: "message-2",
            sessionUpdate: "agent_message_chunk",
        });
        const recovery = {
            executingPromptRequest: {
                attemptId: "attempt-2",
                commandId: "command-2",
                epoch: "epoch-2",
                events: [executingEvent],
                tailCursor: "event-2",
                truncated: false,
            },
            history: {
                events: [historyEvent],
                nextCursor: "older-message-cursor",
                tailCursor: "event-1",
                truncated: false,
                version: 2,
            },
        } as const;

        expect(decodeNativeSessionEventsV2(encodeNativeSessionEventsV2(recovery))).toEqual(recovery);
    });

    it("Given prompt execution fails before start or in flight, When lifecycle records cross the V2 boundary, Then their typed code and message remain intact", () => {
        const page = {
            events: [
                {
                    ...event(1, {
                        content: { text: "ignored", type: "text" },
                        sessionUpdate: "agent_message_chunk",
                    }),
                    payload: {
                        commandId: "command-1",
                        content: [{ text: "hello", type: "text" }],
                        kind: "prompt.requested",
                    },
                    type: "lifecycle-metadata",
                },
                {
                    ...event(2, {
                        content: { text: "ignored", type: "text" },
                        sessionUpdate: "agent_message_chunk",
                    }),
                    payload: {
                        code: "directory_unavailable",
                        commandId: "command-1",
                        kind: "prompt.failed-before-start",
                        message: "The selected directory is unavailable",
                    },
                    type: "lifecycle-metadata",
                },
                {
                    ...event(3, {
                        content: { text: "ignored", type: "text" },
                        sessionUpdate: "agent_message_chunk",
                    }),
                    payload: {
                        attemptId: "attempt-2",
                        code: "agent_execution_failed",
                        commandId: "command-2",
                        kind: "prompt.failed",
                        message: "The local agent could not complete the request",
                    },
                    type: "lifecycle-metadata",
                },
            ],
            nextCursor: null,
            tailCursor: "event-3",
            truncated: false,
            version: 2,
        } as const;

        expect(decodeSessionEventLogPageV2(encodeSessionEventLogPageV2(page))).toEqual(page);
    });

    it("Given queue and interaction facts occur during a prompt, When the V2 page crosses the boundary, Then the facts remain typed and ordered", () => {
        const page = {
            events: [
                {
                    ...event(1, {
                        content: { text: "ignored", type: "text" },
                        sessionUpdate: "agent_message_chunk",
                    }),
                    payload: { kind: "session.queue.changed" },
                    type: "lifecycle-metadata",
                },
                {
                    ...event(2, {
                        content: { text: "ignored", type: "text" },
                        sessionUpdate: "agent_message_chunk",
                    }),
                    payload: {
                        event: {
                            commandId: "command-1",
                            interactionId: "interaction-1",
                            kind: "session.permission.requested",
                            options: [{ kind: "allow_once", name: "Allow once", optionId: "allow-once" }],
                            sessionId: "session-1",
                            title: "Read the file",
                            toolCallId: "tool-1",
                            toolKind: "read",
                        },
                        kind: "session.permission.requested",
                    },
                    type: "lifecycle-metadata",
                },
            ],
            nextCursor: null,
            tailCursor: "event-2",
            truncated: false,
            version: 2,
        } as const;

        expect(decodeSessionEventLogPageV2(encodeSessionEventLogPageV2(page))).toEqual(page);
    });

    it("Given an invalid or oversized raw ACP update, When it crosses the V2 boundary, Then it is rejected with a typed protocol failure", () => {
        for (const update of [
            { sessionUpdate: "unknown_update" },
            {
                content: { text: "x".repeat(1_000_001), type: "text" },
                sessionUpdate: "agent_message_chunk",
            },
        ]) {
            expect(() =>
                decodeSessionEventLogPageV2({
                    events: [
                        {
                            eventId: "event-1",
                            payload: update,
                            position: "1",
                            provenance: { kind: "original" },
                            recordedAt,
                            sessionId: "session-1",
                            type: "acp",
                        },
                    ],
                    nextCursor: null,
                    tailCursor: "event-1",
                    truncated: false,
                    version: 2,
                }),
            ).toThrow(ProtocolMessageError);
        }
    });
});
