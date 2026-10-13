import { describe, expect, it } from "vitest";
import {
    contentBlockV3Schema,
    decodeDaemonToServiceMessage,
    decodeServiceToDaemonMessage,
    decodeSessionHistoryPageV3,
    decodeSessionLiveEventEnvelopeV3,
    decodeSessionRecordingPageV3,
    decodeSessionRecordingWriteV3,
    encodeDaemonToServiceMessage,
    encodeServiceToDaemonMessage,
    type SessionHistoryPageLoadedV3,
} from "../src/index.ts";

describe("Session V3 transport contract", () => {
    it("Given a direct V3 prompt is accepted, When Runtime acknowledges it, Then the started event crosses daemon transport", () => {
        const started = {
            attemptId: "attempt-1",
            commandId: "command-1",
            epoch: "epoch-1",
            kind: "session.started" as const,
            prompt: "Hello",
            sequence: 0 as const,
            sessionId: "session-1",
        };

        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(started))).toEqual(started);
    });

    it("Given V3 content, When it crosses the protocol boundary, Then external content is accepted and embedded binary content is rejected", () => {
        expect(
            contentBlockV3Schema.parse({
                byteLength: 42,
                imageKey: "a".repeat(64),
                mimeType: "image/png",
                type: "external_image",
            }),
        ).toEqual({
            byteLength: 42,
            imageKey: "a".repeat(64),
            mimeType: "image/png",
            type: "external_image",
        });
        expect(() =>
            contentBlockV3Schema.parse({ data: "embedded-data", mimeType: "image/png", type: "image" }),
        ).toThrowError();
        expect(() =>
            contentBlockV3Schema.parse({ data: "embedded-data", mimeType: "audio/wav", type: "audio" }),
        ).toThrowError();
        expect(() =>
            contentBlockV3Schema.parse({ resource: { text: "embedded", uri: "file:///resource" }, type: "resource" }),
        ).toThrowError();
    });

    it("Given native message deltas, When the daemon encodes live delivery, Then stable message identity and sequence order survive transport", () => {
        const encoded = encodeDaemonToServiceMessage({
            kind: "session.live.v3",
            events: [
                {
                    sessionId: "session-1",
                    seq: 41,
                    item: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "item-123",
                        content: { type: "text", text: "Hello " },
                    },
                },
                {
                    sessionId: "session-1",
                    seq: 42,
                    item: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "item-123",
                        content: { type: "text", text: "world" },
                    },
                },
            ],
        });

        expect(decodeDaemonToServiceMessage(encoded)).toEqual({
            kind: "session.live.v3",
            events: [
                {
                    sessionId: "session-1",
                    seq: 41,
                    item: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "item-123",
                        content: { type: "text", text: "Hello " },
                    },
                },
                {
                    sessionId: "session-1",
                    seq: 42,
                    item: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "item-123",
                        content: { type: "text", text: "world" },
                    },
                },
            ],
        });
    });

    it("Given a V3 history request and response, When each crosses its transport boundary, Then the opaque cursor and sequence watermark remain independent", () => {
        const request = {
            kind: "session.history.v3.page.load" as const,
            requestId: "request-1",
            sessionId: "session-1",
            cursor: null,
            messageLimit: 50,
        };
        expect(decodeServiceToDaemonMessage(encodeServiceToDaemonMessage(request))).toEqual(request);

        const response: SessionHistoryPageLoadedV3 = {
            kind: "session.history.v3.page.loaded" as const,
            requestId: "request-1",
            sessionId: "session-1",
            page: {
                messages: [
                    {
                        sessionId: "session-1",
                        messageId: "item-123",
                        item: {
                            sessionUpdate: "agent_message",
                            content: [{ type: "text", text: "Hello world" }],
                        },
                    },
                ],
                nextCursor: "native-cursor",
                throughSeq: 42,
            },
        };
        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(response))).toEqual(response);
    });

    it("Given malformed V3 delivery, When it is decoded, Then duplicate sequence numbers and cross-Session history are rejected", () => {
        expect(() =>
            decodeSessionLiveEventEnvelopeV3({
                kind: "session.live.v3",
                events: [
                    {
                        sessionId: "session-1",
                        seq: 7,
                        item: {
                            sessionUpdate: "agent_message_chunk",
                            messageId: "item-1",
                            content: { type: "text", text: "first" },
                        },
                    },
                    {
                        sessionId: "session-1",
                        seq: 7,
                        item: {
                            sessionUpdate: "agent_message_chunk",
                            messageId: "item-1",
                            content: { type: "text", text: "duplicate" },
                        },
                    },
                ],
            }),
        ).toThrowError();

        expect(() =>
            decodeSessionHistoryPageV3({
                messages: [
                    {
                        sessionId: "session-2",
                        messageId: "item-1",
                        item: { sessionUpdate: "agent_message", content: [] },
                    },
                    {
                        sessionId: "session-2",
                        messageId: "item-1",
                        item: { sessionUpdate: "agent_message", content: [] },
                    },
                ],
                nextCursor: null,
                throughSeq: 7,
            }),
        ).toThrowError();
    });

    it("Given a Session lifecycle change, When it crosses V3 transport, Then execution context is present only for connected and running states", () => {
        const connected = {
            events: [
                {
                    item: {
                        sessionUpdate: "session_lifecycle_changed" as const,
                        state: {
                            context: {
                                additionalDirectoryIds: ["other-root"],
                                agentId: "codex",
                                directoryId: "root",
                            },
                            kind: "connected" as const,
                        },
                    },
                    seq: 1,
                    sessionId: "session-1",
                },
            ],
            kind: "session.live.v3" as const,
        };
        expect(decodeSessionLiveEventEnvelopeV3(connected)).toEqual(connected);
        expect(() =>
            decodeSessionLiveEventEnvelopeV3({
                events: [
                    {
                        item: {
                            agentId: "codex",
                            directoryId: "root",
                            sessionUpdate: "session_lifecycle_changed",
                            state: "connected",
                        },
                        seq: 1,
                        sessionId: "session-1",
                    },
                ],
                kind: "session.live.v3",
            }),
        ).toThrowError();
    });

    it("Given V3 recording data, When it crosses the recording boundary, Then sequence cursors and gaps remain explicit", () => {
        const event = {
            item: {
                content: { text: "recorded", type: "text" as const },
                messageId: "item-1",
                sessionUpdate: "agent_message_chunk" as const,
            },
            seq: 42,
            sessionId: "session-1",
        };
        expect(
            decodeSessionRecordingWriteV3(
                JSON.stringify({
                    envelope: { events: [event], kind: "session.live.v3" },
                    projectId: "project-1",
                    recordedAt: "2026-10-13T00:00:00.000Z",
                    runtimeId: "runtime-1",
                }),
            ),
        ).toMatchObject({ envelope: { events: [event] } });
        expect(
            decodeSessionRecordingPageV3(
                JSON.stringify({
                    events: [{ event, recordedAt: "2026-10-13T00:00:00.000Z" }],
                    gaps: [{ fromSeq: 41, toSeq: 41 }],
                    nextCursor: 42,
                    sessionId: "session-1",
                    tailSeq: 42,
                    version: 3,
                }),
            ),
        ).toMatchObject({ gaps: [{ fromSeq: 41, toSeq: 41 }], nextCursor: 42, tailSeq: 42 });
        expect(() =>
            decodeSessionRecordingWriteV3(
                JSON.stringify({
                    envelope: {
                        events: [event, { ...event, seq: 43, sessionId: "session-2" }],
                        kind: "session.live.v3",
                    },
                    projectId: "project-1",
                    recordedAt: "2026-10-13T00:00:00.000Z",
                    runtimeId: "runtime-1",
                }),
            ),
        ).toThrowError();
    });
});
