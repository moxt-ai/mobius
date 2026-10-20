import {
    decodeDaemonToServiceMessage,
    decodeServiceToDaemonMessage,
    encodeDaemonToServiceMessage,
    encodeServiceToDaemonMessage,
    SESSION_CONFIG_READ_KIND,
    SESSION_CONFIG_READ_RESULT_KIND,
    SESSION_USAGE_READ_KIND,
    SESSION_USAGE_READ_RESULT_KIND,
    type SessionReadyEvent,
    type SessionUsageReadResult,
} from "@moxt-ai/mobius-sdk/protocol";
import { describe, expect, it } from "vitest";

const usage = {
    cost: { amount: 0.42, currency: "USD" },
    size: 200_000,
    updatedAt: "2026-10-20T00:00:00.000Z",
    used: 12_345,
} as const;

describe("Session config and usage read contracts", () => {
    it("Given a config read command, When it crosses the daemon boundary, Then it round-trips", () => {
        const command = {
            kind: SESSION_CONFIG_READ_KIND,
            requestId: "request-config-1",
            sessionId: "session-1",
        } as const;
        const encoded = encodeServiceToDaemonMessage(command);
        expect(decodeServiceToDaemonMessage(encoded)).toEqual(command);
    });

    it("Given a usage read command, When it crosses the daemon boundary, Then it round-trips", () => {
        const command = {
            kind: SESSION_USAGE_READ_KIND,
            requestId: "request-usage-1",
            sessionId: "session-1",
        } as const;
        const encoded = encodeServiceToDaemonMessage(command);
        expect(decodeServiceToDaemonMessage(encoded)).toEqual(command);
    });

    it("Given a config read result, When it crosses the daemon boundary, Then it round-trips", () => {
        const result = {
            configOptions: [
                {
                    booleanValue: false,
                    category: "model",
                    currentValue: "test-large",
                    description: "Model",
                    id: "model",
                    name: "Model",
                    type: "select",
                    values: [
                        { description: "", groupId: "", groupName: "", name: "Test Small", value: "test-small" },
                        { description: "", groupId: "", groupName: "", name: "Test Large", value: "test-large" },
                    ],
                },
            ],
            kind: SESSION_CONFIG_READ_RESULT_KIND,
            requestId: "request-config-1",
            sessionId: "session-1",
        } as const;
        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(result))).toEqual(result);
    });

    it("Given a usage read result without agent-reported usage, When it crosses the daemon boundary, Then null is preserved", () => {
        const result = {
            kind: SESSION_USAGE_READ_RESULT_KIND,
            requestId: "request-usage-1",
            sessionId: "session-1",
            usage: null,
        } as const;
        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(result))).toEqual(result);
    });

    it("Given a usage read result with a snapshot, When it crosses the daemon boundary, Then the snapshot survives", () => {
        const result: SessionUsageReadResult = {
            kind: SESSION_USAGE_READ_RESULT_KIND,
            requestId: "request-usage-1",
            sessionId: "session-1",
            usage: usage,
        };
        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(result))).toEqual(result);
    });

    it("Given a session ready event, When usage is absent, Then decoding rejects it", () => {
        const ready = {
            additionalDirectories: [],
            agentId: "codex",
            agentName: "Codex",
            agentVersion: "1.0.0",
            capabilities: {
                additionalDirectories: false,
                audioPrompt: false,
                closeSession: true,
                deleteSession: false,
                embeddedContextPrompt: false,
                imagePrompt: false,
                listSessions: false,
                loadSession: false,
                promptQueueing: false,
                renameSession: false,
                resumeSession: false,
                steering: false,
                unstableForkSession: false,
            },
            commands: [],
            configOptions: [],
            directoryId: "root",
            directoryLabel: "Workspace",
            kind: "session.ready",
            requestId: "request-1",
            restored: false,
            sessionId: "session-1",
        };
        expect(() =>
            decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(ready as unknown as SessionReadyEvent)),
        ).toThrow();
    });
});
