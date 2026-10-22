import {
    decodeDaemonToServiceMessage,
    decodeSessionClosedEvent,
    decodeSessionCloseNoticeEvent,
    encodeDaemonToServiceMessage,
    encodeSessionClosedEvent,
    SESSION_CLOSE_NOTICE_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { describe, expect, it } from "vitest";

describe("Session close notice contracts", () => {
    it("Given a Runtime reports that it closed a Session, When the notice crosses the daemon-to-service boundary, Then receivers decode the same notice with its reason", () => {
        const notice = { kind: SESSION_CLOSE_NOTICE_KIND, reason: "requested", sessionId: "session-1" } as const;

        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(notice))).toEqual(notice);
    });

    it("Given a notice whose reason a newer Runtime introduced, When a receiver decodes it, Then the reason arrives as sent", () => {
        const encoded = JSON.stringify({ kind: SESSION_CLOSE_NOTICE_KIND, reason: "idle", sessionId: "session-1" });

        expect(decodeSessionCloseNoticeEvent(encoded)).toEqual({
            kind: SESSION_CLOSE_NOTICE_KIND,
            reason: "idle",
            sessionId: "session-1",
        });
    });

    it("Given a notice from a newer Runtime with an extra field, When a receiver decodes it, Then the unrecognized field is ignored", () => {
        const encoded = JSON.stringify({
            closedAt: "2026-10-22T00:00:00.000Z",
            kind: SESSION_CLOSE_NOTICE_KIND,
            reason: "requested",
            sessionId: "session-1",
        });

        expect(decodeSessionCloseNoticeEvent(encoded)).toEqual({
            kind: SESSION_CLOSE_NOTICE_KIND,
            reason: "requested",
            sessionId: "session-1",
        });
    });

    it("Given a notice without a valid Session identifier or reason, When it crosses the boundary, Then it is rejected", () => {
        const invalid = [
            { kind: SESSION_CLOSE_NOTICE_KIND, reason: "requested" },
            { kind: SESSION_CLOSE_NOTICE_KIND, reason: "requested", sessionId: "" },
            { kind: SESSION_CLOSE_NOTICE_KIND, sessionId: "session-1" },
            { kind: SESSION_CLOSE_NOTICE_KIND, reason: "", sessionId: "session-1" },
            { kind: SESSION_CLOSE_NOTICE_KIND, reason: "r".repeat(129), sessionId: "session-1" },
        ];

        for (const notice of invalid) {
            expect(() => decodeSessionCloseNoticeEvent(JSON.stringify(notice))).toThrow();
        }
    });

    it("Given an older Runtime that only answers a close request, When its reply crosses the boundary, Then the previous representation is still accepted", () => {
        const reply = { kind: "session.closed", requestId: "request-1", sessionId: "session-1" } as const;

        expect(decodeSessionClosedEvent(encodeSessionClosedEvent(reply))).toEqual(reply);
        expect(decodeDaemonToServiceMessage(encodeSessionClosedEvent(reply))).toEqual(reply);
    });
});
