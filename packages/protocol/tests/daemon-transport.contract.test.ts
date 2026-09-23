import { describe, expect, it } from "vitest";

import {
    decodeDaemonToServiceMessage,
    decodeServiceToDaemonMessage,
    encodeDaemonToServiceMessage,
    encodeServiceToDaemonMessage,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    SESSION_CANCEL_KIND,
    SESSION_READY_KIND,
} from "../src/index.ts";

describe("daemon transport protocol", () => {
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
