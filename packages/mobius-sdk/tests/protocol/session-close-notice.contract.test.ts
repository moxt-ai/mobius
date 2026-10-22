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
    it("Given a Runtime reports that it closed a Session, When the notice crosses the daemon-to-service boundary, Then receivers decode the same notice", () => {
        const notice = { kind: SESSION_CLOSE_NOTICE_KIND, sessionId: "session-1" } as const;

        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(notice))).toEqual(notice);
    });

    it("Given a notice from a newer Runtime with an extra field, When a receiver decodes it, Then the unrecognized field is ignored", () => {
        const encoded = JSON.stringify({ kind: SESSION_CLOSE_NOTICE_KIND, reason: "idle", sessionId: "session-1" });

        expect(decodeSessionCloseNoticeEvent(encoded)).toEqual({
            kind: SESSION_CLOSE_NOTICE_KIND,
            sessionId: "session-1",
        });
    });

    it("Given a notice without a valid Session identifier, When it crosses the boundary, Then it is rejected", () => {
        expect(() => decodeSessionCloseNoticeEvent(JSON.stringify({ kind: SESSION_CLOSE_NOTICE_KIND }))).toThrow();
        expect(() =>
            decodeSessionCloseNoticeEvent(JSON.stringify({ kind: SESSION_CLOSE_NOTICE_KIND, sessionId: "" })),
        ).toThrow();
    });

    it("Given an older Runtime that only answers a close request, When its reply crosses the boundary, Then the previous representation is still accepted", () => {
        const reply = { kind: "session.closed", requestId: "request-1", sessionId: "session-1" } as const;

        expect(decodeSessionClosedEvent(encodeSessionClosedEvent(reply))).toEqual(reply);
        expect(decodeDaemonToServiceMessage(encodeSessionClosedEvent(reply))).toEqual(reply);
    });
});
