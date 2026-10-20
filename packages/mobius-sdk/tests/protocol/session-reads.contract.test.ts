import {
    decodeDaemonToServiceMessage,
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
            kind: SESSION_CONFIG_READ_RESULT_KIND,
            requestId: "request-config-1",
            sessionId: "session-1",
        } as const;
        expect(decodeDaemonToServiceMessage(encodeDaemonToServiceMessage(result))).toEqual(result);
    });
});
