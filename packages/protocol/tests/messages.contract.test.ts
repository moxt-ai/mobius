import { describe, expect, it } from "vitest";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityEvent,
    type AgentMessageDeltaEvent,
    decodeAgentActivityEvent,
    decodeAgentMessageDeltaEvent,
    decodeSessionCancelCommand,
    decodeSessionPromptCommand,
    encodeAgentActivityEvent,
    ProtocolMessageError,
    SESSION_CANCEL_KIND,
    SESSION_PROMPT_KIND,
    SessionPromptDisposition,
} from "../src/index.ts";

describe("session prompt protocol", () => {
    it("Given a prompt has no text, images or resources, When it crosses the daemon boundary, Then it is rejected", () => {
        expect(() =>
            decodeSessionPromptCommand(
                JSON.stringify({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: "workspace",
                    commandId: "command-1",
                    directoryId: "default",
                    disposition: SessionPromptDisposition.Reject,
                    images: [],
                    kind: SESSION_PROMPT_KIND,
                    prompt: "",
                    resources: [],
                    sessionId: "session-1",
                    targetCommandId: "",
                }),
            ),
        ).toThrowError(ProtocolMessageError);
    });

    it("Given a prompt contains a remote working directory, When it crosses the protocol boundary, Then the authority override is rejected", () => {
        const encoded = JSON.stringify({
            agentId: "codex",
            additionalDirectoryIds: [],
            bindingId: "workspace",
            commandId: "command-1",
            cwd: "/tmp/untrusted",
            directoryId: "default",
            images: [],
            kind: SESSION_PROMPT_KIND,
            prompt: "hello from browser",
            resources: [],
            sessionId: "session-1",
        });

        expect(() => decodeSessionPromptCommand(encoded)).toThrowError(ProtocolMessageError);
    });
});

describe("agent message protocol", () => {
    it("Given an Agent emits a native message anchor, When its text crosses the durable event boundary, Then the anchor remains available for turn forking", () => {
        const event: AgentMessageDeltaEvent = {
            commandId: "command-1",
            epoch: "epoch-1",
            kind: AGENT_MESSAGE_DELTA_KIND,
            messageId: "agent-message-1",
            sequence: 1,
            sessionId: "session-1",
            text: "done",
        };

        expect(decodeAgentMessageDeltaEvent(JSON.stringify(event))).toEqual(event);
    });
});

describe("session cancel protocol", () => {
    it("Given cancellation contains a remote target override, When it is decoded, Then the untrusted field is rejected", () => {
        const encoded = JSON.stringify({
            commandId: "command-1",
            cwd: "/tmp/untrusted",
            kind: SESSION_CANCEL_KIND,
            sessionId: "session-1",
        });

        expect(() => decodeSessionCancelCommand(encoded)).toThrowError(ProtocolMessageError);
    });
});

describe("agent activity protocol", () => {
    it("Given a normalized tool update, When it crosses the relay boundary, Then every display field round-trips", () => {
        const activity: AgentActivityEvent = {
            activityId: "tool-1",
            activityType: "tool",
            commandId: "command-1",
            input: '{"command":"pnpm test"}',
            toolKind: "execute",
            locations: ["/workspace/package.json"],
            name: "exec_command",
            output: "Tests passed",
            content: [
                {
                    artifactId: "",
                    data: "",
                    mimeType: "",
                    name: "",
                    newText: "const ready = true;",
                    oldText: "const ready = false;",
                    path: "/workspace/index.ts",
                    terminalId: "",
                    text: "",
                    type: "diff",
                    uri: "",
                },
            ],
            detail: {
                content: [],
                input: '{"command":"pnpm test -- --reporter=verbose"}',
                kind: "recorded",
                output: "Complete test output",
            },
            sequence: 2,
            sessionId: "session-1",
            status: "completed",
            kind: AGENT_ACTIVITY_KIND,
            title: "Run the test suite",
        };

        expect(decodeAgentActivityEvent(encodeAgentActivityEvent(activity))).toEqual(activity);
    });

    it("Given an activity has an unknown lifecycle state, When it is decoded, Then the untrusted event is rejected", () => {
        const encoded = JSON.stringify({
            activityId: "tool-1",
            activityType: "tool",
            commandId: "command-1",
            input: "",
            content: [],
            detail: { kind: "unrecorded" },
            kind: AGENT_ACTIVITY_KIND,
            locations: [],
            name: "read_file",
            output: "",
            sequence: 0,
            sessionId: "session-1",
            status: "surprising",
            title: "Read a file",
            toolKind: "read",
        });

        expect(() => decodeAgentActivityEvent(encoded)).toThrowError(ProtocolMessageError);
    });
});
