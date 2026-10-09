import { describe, expect, it } from "vitest";

import {
    decodeDaemonToServiceMessage,
    decodeServiceToDaemonMessage,
    decodeSessionsQueriedEvent,
    encodeDaemonToServiceMessage,
    encodeServiceToDaemonMessage,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_PING_KIND,
    RUNTIME_PONG_KIND,
    SESSION_CANCEL_KIND,
    SESSION_READY_KIND,
} from "../src/index.ts";

describe("daemon transport protocol", () => {
    it("Given the retired live event envelope, When a daemon sends it, Then the transport rejects it", () => {
        expect(() =>
            decodeDaemonToServiceMessage(
                JSON.stringify({ kind: "session.event", sessionId: "session", payload: "{}" }),
            ),
        ).toThrow();
    });
    it.each(["delete", "fork-recorded"])(
        "Given the removed native %s operation, When a remote client sends it, Then the daemon protocol rejects it",
        (action) => {
            expect(() =>
                decodeServiceToDaemonMessage(
                    JSON.stringify({
                        kind: "native.session.request",
                        action,
                        additionalDirectoryIds: [],
                        agentId: "claude",
                        bindingId: "workspace",
                        directoryId: "default",
                        requestId: "request-1",
                        sessionId: "source",
                        entryId: "entry-1",
                        targetSessionId: "target",
                        throughCommandId: "command-1",
                    }),
                ),
            ).toThrow();
        },
    );
    it("Given an older Session response and future additive fields, When a newer boundary decodes it, Then known fields remain usable with documented fallbacks", () => {
        expect(
            decodeSessionsQueriedEvent(
                JSON.stringify({
                    entries: [
                        {
                            additionalDirectories: [],
                            agentId: "codex",
                            directoryId: "default",
                            directoryLabel: "Default",
                            futureMetadata: { enabled: true },
                            prompted: true,
                            sessionId: "session-1",
                            title: "Existing session",
                            updatedAt: "2026-10-08T00:00:00.000Z",
                        },
                    ],
                    futureEnvelope: "ignored",
                    kind: "session.queried",
                    requestId: "request-1",
                }),
            ),
        ).toEqual({
            entries: [
                {
                    additionalDirectories: [],
                    agentId: "codex",
                    directoryId: "default",
                    directoryLabel: "Default",
                    prompted: true,
                    sessionId: "session-1",
                    status: { kind: "idle" },
                    title: "Existing session",
                    updatedAt: "2026-10-08T00:00:00.000Z",
                },
            ],
            kind: "session.queried",
            requestId: "request-1",
        });
    });

    it("Given typed service and daemon messages, When they cross the transport boundary, Then each direction validates and round-trips its supported messages", () => {
        const serviceMessage = {
            commandId: "command-1",
            kind: SESSION_CANCEL_KIND,
            sessionId: "session-1",
        } as const;
        const daemonMessage = {
            heartbeatId: "heartbeat-1",
            kind: RUNTIME_HEARTBEAT_KIND,
        } as const;

        expect(decodeServiceToDaemonMessage(encodeServiceToDaemonMessage(serviceMessage))).toEqual(serviceMessage);
        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(daemonMessage))).toEqual(daemonMessage);
        const ping = { kind: RUNTIME_PING_KIND, requestId: "ping-1" } as const;
        const pong = { kind: RUNTIME_PONG_KIND, requestId: "ping-1" } as const;
        expect(decodeServiceToDaemonMessage(encodeServiceToDaemonMessage(ping))).toEqual(ping);
        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(pong))).toEqual(pong);
    });

    it("Given a valid message is sent in the wrong direction, When the boundary decodes it, Then the unsupported direction is rejected", () => {
        expect(() =>
            decodeDaemonToServiceMessage(
                JSON.stringify({ heartbeatId: "heartbeat-1", kind: RUNTIME_HEARTBEAT_ACK_KIND }),
            ),
        ).toThrowError("Unsupported daemon-to-service message kind: runtime.heartbeat.ack");
        expect(() =>
            decodeServiceToDaemonMessage(
                JSON.stringify({
                    additionalDirectories: [],
                    agentId: "codex",
                    agentName: "Codex",
                    agentVersion: "1.0.0",
                    capabilities: {},
                    commands: [],
                    configOptions: [],
                    directoryId: "default",
                    directoryLabel: "Default",
                    kind: SESSION_READY_KIND,
                    requestId: "request-1",
                    restored: false,
                    sessionId: "session-1",
                }),
            ),
        ).toThrowError("Unsupported service-to-daemon message kind: session.ready");
    });
});
