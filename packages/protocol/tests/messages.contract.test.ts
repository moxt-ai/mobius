import { describe, expect, it } from "vitest";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityEvent,
    type AgentMessageDeltaEvent,
    decodeAgentActivityEvent,
    decodeAgentMessageDeltaEvent,
    decodeNativeSessionRequest,
    decodeRuntimeLivenessReadyEvent,
    decodeSessionCancelCommand,
    decodeSessionEventAcknowledgement,
    decodeSessionEventEnvelope,
    decodeSessionPromptCommand,
    decodeSessionRecordingDirectory,
    decodeSessionRecordingHistory,
    decodeSessionRecordingWrite,
    encodeAgentActivityEvent,
    encodeNativeSessionRequest,
    encodeRuntimeLivenessReadyEvent,
    encodeSessionEventAcknowledgement,
    encodeSessionEventEnvelope,
    ProtocolMessageError,
    SESSION_CANCEL_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_KIND,
    SESSION_PROMPT_KIND,
    type SessionEventAcknowledgement,
    type SessionEventEnvelope,
    SessionPromptDisposition,
} from "../src/index.ts";

describe("session Recording protocol", () => {
    it("Given Web selects a terminal recorded Turn, When it requests a native fork, Then source and destination identity round-trip", () => {
        const request = {
            action: "fork-recorded",
            additionalDirectoryIds: [],
            agentId: "codex",
            bindingId: "workspace",
            directoryId: "default",
            kind: "native.session.request",
            requestId: "request-fork-1",
            sessionId: "session-parent",
            targetSessionId: "session-child",
            throughCommandId: "command-1",
        } as const;

        expect(decodeNativeSessionRequest(encodeNativeSessionRequest(request))).toEqual(request);
    });

    it("Given Recording has Sessions for a Runtime, When Web loads its directory, Then identity and display metadata remain bound to each Session", () => {
        const directory = {
            sessions: [
                {
                    additionalDirectoryIds: ["docs"],
                    agentId: "codex",
                    directoryId: "workspace",
                    runtimeId: "runtime-1",
                    sessionId: "session-1",
                    title: "Remember this",
                    updatedAt: "2026-09-29T00:00:00.000Z",
                },
            ],
        };

        expect(decodeSessionRecordingDirectory(JSON.stringify(directory))).toEqual(directory);
    });

    it("Given a reliable Session event is accepted by a Recording provider, When it crosses the provider boundary, Then its Project and Runtime identity remain bound to the event", () => {
        const request = {
            envelope: {
                delivery: {
                    eventId: "event-1",
                    kind: "reliable" as const,
                    sourceSeq: "1",
                    streamId: "stream-1",
                },
                kind: SESSION_EVENT_KIND,
                payload: JSON.stringify({
                    attemptId: "attempt-1",
                    commandId: "command-1",
                    epoch: "epoch-1",
                    kind: "session.started",
                    prompt: "Remember this",
                    sequence: 0,
                    sessionId: "session-1",
                }),
                sessionId: "session-1",
            },
            projectId: "standalone",
            runtimeId: "runtime-1",
        };

        expect(decodeSessionRecordingWrite(JSON.stringify(request))).toEqual(request);
    });

    it("Given Recording has persisted a forked Session, When Web loads that Session, Then it receives ordered lineage segments ending at the selected parent Turn", () => {
        const history = {
            segments: [
                {
                    entries: [
                        {
                            envelope: {
                                delivery: {
                                    eventId: "event-1",
                                    kind: "reliable" as const,
                                    sourceSeq: "1",
                                    streamId: "stream-1",
                                },
                                kind: SESSION_EVENT_KIND,
                                payload: JSON.stringify({ kind: "session.queue.changed", sessionId: "session-1" }),
                                sessionId: "session-1",
                            },
                            recordedAt: "2026-09-29T00:00:00.000Z",
                        },
                    ],
                    recordingEpoch: "recording-epoch-1",
                    sessionId: "session-1",
                    throughCommandId: "command-1",
                },
            ],
            sessionId: "session-2",
        };

        expect(decodeSessionRecordingHistory(JSON.stringify(history))).toEqual(history);
    });

    it("Given a child Session is forked from a terminal recorded Turn, When the event crosses the Recording boundary, Then its lineage identity round-trips", () => {
        const request = {
            envelope: {
                delivery: {
                    eventId: "event-fork-1",
                    kind: "reliable" as const,
                    sourceSeq: "2",
                    streamId: "stream-1",
                },
                kind: SESSION_EVENT_KIND,
                payload: JSON.stringify({
                    kind: "session.forked",
                    sessionId: "session-2",
                    sourceSessionId: "session-1",
                    throughCommandId: "command-1",
                }),
                sessionId: "session-2",
            },
            projectId: "standalone",
            runtimeId: "runtime-1",
        };

        expect(decodeSessionRecordingWrite(JSON.stringify(request))).toEqual(request);
    });
});

describe("reliable session event protocol", () => {
    it("Given a Runtime assigns durable delivery identity, When the event crosses the Relay boundary, Then the identity round-trips with its payload", () => {
        const envelope: SessionEventEnvelope = {
            delivery: {
                eventId: "event-1",
                kind: "reliable",
                sourceSeq: "42",
                streamId: "stream-1",
            },
            kind: SESSION_EVENT_KIND,
            payload: JSON.stringify({ kind: "session.queue.changed", sessionId: "session-1" }),
            sessionId: "session-1",
        };

        expect(decodeSessionEventEnvelope(encodeSessionEventEnvelope(envelope))).toEqual(envelope);
    });

    it("Given Recording is disabled for a reliable event, When Relay accepts its live delivery, Then the acknowledgement records that no durable recording was required", () => {
        const acknowledgement: SessionEventAcknowledgement = {
            eventId: "event-1",
            kind: SESSION_EVENT_ACK_KIND,
            outcome: { kind: "relayed" },
            sessionId: "session-1",
        };

        expect(decodeSessionEventAcknowledgement(encodeSessionEventAcknowledgement(acknowledgement))).toEqual(
            acknowledgement,
        );
    });
});

describe("runtime delivery negotiation", () => {
    it("Given both Runtime and Relay support reliable Session events, When liveness becomes ready, Then the selected delivery mode is explicit", () => {
        const ready = { kind: "runtime.liveness.ready" as const, sessionEventDelivery: "reliable-v1" as const };
        expect(decodeRuntimeLivenessReadyEvent(encodeRuntimeLivenessReadyEvent(ready))).toEqual(ready);
    });
});

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
