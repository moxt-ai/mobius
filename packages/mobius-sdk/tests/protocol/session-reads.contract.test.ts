import {
    decodeDaemonToServiceMessage,
    decodeNativeSessionResult,
    decodeServiceToDaemonMessage,
    encodeDaemonToServiceMessage,
    encodeServiceToDaemonMessage,
    SESSION_CONFIG_READ_KIND,
    SESSION_CONFIG_READ_RESULT_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { describe, expect, it } from "vitest";

describe("Session config read contracts", () => {
    it("Given a config read command, When it crosses the daemon boundary, Then it round-trips", () => {
        const command = {
            kind: SESSION_CONFIG_READ_KIND,
            requestId: "request-config-1",
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
            configurationRevision: "revision-1",
            kind: SESSION_CONFIG_READ_RESULT_KIND,
            requestId: "request-config-1",
            sessionId: "session-1",
        } as const;
        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(result))).toEqual(result);
    });
});

describe("Session execution read contracts", () => {
    const execution = {
        action: "active-turn",
        kind: "native.session.result",
        queued: [],
        queuedCancellation: "before-start",
        requestId: "request-execution-1",
        sessionId: "session-1",
        targetSessionId: "session-1",
        turn: null,
    } as const;

    // @no-uc: Compatibility; a delivery state from a newer Runtime must not fail the execution read it rides on.
    it("Given an execution whose command delivery state this reader does not know, When it is decoded, Then the execution is kept and the delivery reads as absent", () => {
        const decoded = decodeNativeSessionResult(
            JSON.stringify({ ...execution, command: { state: "superseded", by: "command-2" } }),
        );
        expect(decoded).toMatchObject({ action: "active-turn", turn: null, queued: [] });
        expect(decoded.action === "active-turn" ? decoded.command : null).toBeUndefined();
    });

    // @no-uc: Compatibility; a last-turn outcome from a newer Runtime must not fail the execution read it rides on.
    it("Given an execution whose last turn outcome this reader does not know, When it is decoded, Then the execution is kept and the outcome reads as absent", () => {
        const decoded = decodeNativeSessionResult(
            JSON.stringify({ ...execution, lastTurn: { commandId: "command-1", state: "abandoned" } }),
        );
        expect(decoded).toMatchObject({ action: "active-turn", turn: null, queued: [] });
        expect(decoded.action === "active-turn" ? decoded.lastTurn : null).toBeUndefined();
    });

    it("Given an execution with a known command delivery, When it is decoded, Then the delivery is kept", () => {
        expect(
            decodeNativeSessionResult(JSON.stringify({ ...execution, command: { state: "failed", code: "boom" } })),
        ).toMatchObject({ command: { state: "failed", code: "boom" } });
    });
});
