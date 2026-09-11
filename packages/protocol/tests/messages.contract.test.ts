import { describe, expect, it } from "vitest";

import {
    AGENT_ACTIVITY_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    type AgentActivityEvent,
    type AgentMessageDeltaEvent,
    decodeAgentActivityEvent,
    decodeAgentMessageDeltaEvent,
    decodeRuntimeDelivery,
    decodeRuntimeDeliveryCommitted,
    decodeRuntimeDeliveryReceived,
    decodeRuntimeHeartbeatAckEvent,
    decodeRuntimeHeartbeatEvent,
    decodeRuntimeLivenessReadyEvent,
    decodeSessionCancelCommand,
    decodeSessionEventAcknowledgement,
    decodeSessionEventEnvelope,
    decodeSessionEventRejection,
    decodeSessionPromptCommand,
    encodeAgentActivityEvent,
    encodeRuntimeDelivery,
    encodeRuntimeDeliveryCommitted,
    encodeRuntimeDeliveryReceived,
    encodeRuntimeHeartbeatAckEvent,
    encodeRuntimeHeartbeatEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeSessionCancelCommand,
    encodeSessionEventAcknowledgement,
    encodeSessionEventEnvelope,
    encodeSessionEventRejection,
    encodeSessionPromptCommand,
    encodeSessionStartedEvent,
    ProtocolMessageError,
    RUNTIME_DELIVERY_COMMITTED_KIND,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    type RuntimeDelivery,
    type RuntimeDeliveryCommitted,
    type RuntimeDeliveryReceived,
    type RuntimeHeartbeatAckEvent,
    type RuntimeHeartbeatEvent,
    type RuntimeLivenessReadyEvent,
    SESSION_CANCEL_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_KIND,
    SESSION_EVENT_REJECTED_KIND,
    SESSION_PROMPT_KIND,
    type SessionCancelCommand,
    SessionEventRejectionCode,
    type SessionPromptCommand,
    SessionPromptDisposition,
} from "../src/index.ts";

describe("reliable Runtime delivery protocol", () => {
    it("Given Relay has durable work for one Session, When daemon receipt crosses the WebSocket boundary, Then delivery identity and payload round-trip independently from execution completion", () => {
        const payload = encodeSessionPromptCommand({
            additionalDirectoryIds: [],
            agentId: "codex",
            bindingId: "workspace",
            commandId: "command-1",
            directoryId: "default",
            disposition: SessionPromptDisposition.Reject,
            images: [],
            kind: SESSION_PROMPT_KIND,
            prompt: "run reliably",
            resources: [],
            sessionId: "session-1",
            targetCommandId: "",
        });
        const delivery: RuntimeDelivery = {
            deliveryId: "dispatch-turn-1",
            kind: RUNTIME_DELIVERY_KIND,
            payload,
            sessionId: "session-1",
        };
        const received: RuntimeDeliveryReceived = {
            deliveryId: delivery.deliveryId,
            kind: RUNTIME_DELIVERY_RECEIVED_KIND,
            sessionId: delivery.sessionId,
        };
        const committed: RuntimeDeliveryCommitted = {
            deliveryId: delivery.deliveryId,
            kind: RUNTIME_DELIVERY_COMMITTED_KIND,
            sessionId: delivery.sessionId,
        };

        expect(decodeRuntimeDelivery(encodeRuntimeDelivery(delivery))).toEqual(delivery);
        expect(decodeRuntimeDeliveryReceived(encodeRuntimeDeliveryReceived(received))).toEqual(received);
        expect(decodeRuntimeDeliveryCommitted(encodeRuntimeDeliveryCommitted(committed))).toEqual(committed);
    });
});

describe("reliable session event protocol", () => {
    it("Given a daemon event has a stable identity, When it is retransmitted and acknowledged, Then its identity and durable cursor round-trip exactly", () => {
        const payload = encodeSessionStartedEvent({
            commandId: "command-1",
            kind: "session.started",
            attemptId: "attempt-1",
            sessionId: "session-1",
        });
        const envelope = {
            eventId: "event-1",
            kind: SESSION_EVENT_KIND,
            payload,
            sessionId: "session-1",
            source: {
                attemptId: "attempt-1",
                kind: "attempt",
                sourceSeq: "1",
            },
        } as const;
        const acknowledgement = {
            cursor: "ZXZlbnQtY3Vyc29y",
            duplicate: true,
            eventId: envelope.eventId,
            kind: SESSION_EVENT_ACK_KIND,
            sequence: "12",
            sessionId: envelope.sessionId,
        } as const;

        expect(decodeSessionEventEnvelope(encodeSessionEventEnvelope(envelope))).toEqual(envelope);
        expect(decodeSessionEventAcknowledgement(encodeSessionEventAcknowledgement(acknowledgement))).toEqual(
            acknowledgement,
        );
    });

    it("Given a stale daemon event targets a terminal Session, When the Relay rejects it, Then the event identity and terminal code round-trip exactly", () => {
        const rejection = {
            code: SessionEventRejectionCode.SessionDeleted,
            eventId: "event-1",
            kind: SESSION_EVENT_REJECTED_KIND,
            sessionId: "session-1",
        } as const;

        expect(decodeSessionEventRejection(encodeSessionEventRejection(rejection))).toEqual(rejection);
    });
});

describe("runtime liveness protocol", () => {
    it("Given a liveness-capable relay, When its readiness signal crosses the daemon boundary, Then the capability round-trips exactly", () => {
        const event: RuntimeLivenessReadyEvent = {
            kind: RUNTIME_LIVENESS_READY_KIND,
        };

        expect(decodeRuntimeLivenessReadyEvent(encodeRuntimeLivenessReadyEvent(event))).toEqual(event);
    });

    it("Given a daemon heartbeat identity, When the relay acknowledges it, Then both messages preserve the same identity", () => {
        const heartbeat: RuntimeHeartbeatEvent = {
            heartbeatId: "heartbeat-1",
            kind: RUNTIME_HEARTBEAT_KIND,
        };
        const acknowledgement: RuntimeHeartbeatAckEvent = {
            heartbeatId: heartbeat.heartbeatId,
            kind: RUNTIME_HEARTBEAT_ACK_KIND,
        };

        expect(decodeRuntimeHeartbeatEvent(encodeRuntimeHeartbeatEvent(heartbeat))).toEqual(heartbeat);
        expect(decodeRuntimeHeartbeatAckEvent(encodeRuntimeHeartbeatAckEvent(acknowledgement))).toEqual(
            acknowledgement,
        );
    });
});

describe("session prompt protocol", () => {
    it("Given a valid browser prompt, When it crosses the daemon boundary, Then its complete command round-trips", () => {
        const command: SessionPromptCommand = {
            additionalDirectoryIds: [],
            agentId: "codex",
            bindingId: "workspace",
            commandId: "command-1",
            directoryId: "default",
            disposition: SessionPromptDisposition.Reject,
            images: [
                {
                    data: "aW1hZ2U=",
                    mimeType: "image/png",
                    name: "screenshot.png",
                },
            ],
            kind: SESSION_PROMPT_KIND,
            prompt: "hello from browser",
            resources: [
                {
                    mimeType: "text/plain",
                    name: "notes.txt",
                    text: "supporting context",
                    type: "embedded",
                    uri: "mobius://upload/notes.txt",
                },
            ],
            sessionId: "session-1",
            targetCommandId: "",
        };

        expect(decodeSessionPromptCommand(encodeSessionPromptCommand(command))).toEqual(command);
    });

    it("Given a running Turn identity, When a follow-up crosses the protocol boundary, Then queue and steer intent remain explicit", () => {
        const queued = decodeSessionPromptCommand(
            JSON.stringify({
                additionalDirectoryIds: [],
                agentId: "claude-code",
                bindingId: "workspace",
                commandId: "command-2",
                directoryId: "default",
                disposition: SessionPromptDisposition.Queue,
                images: [],
                kind: SESSION_PROMPT_KIND,
                prompt: "continue after this",
                resources: [],
                sessionId: "session-1",
                targetCommandId: "command-1",
            }),
        );
        const steered = decodeSessionPromptCommand(
            JSON.stringify({ ...queued, commandId: "command-3", disposition: SessionPromptDisposition.Steer }),
        );

        expect(queued.disposition).toBe(SessionPromptDisposition.Queue);
        expect(steered).toMatchObject({
            disposition: SessionPromptDisposition.Steer,
            targetCommandId: "command-1",
        });
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
            kind: AGENT_MESSAGE_DELTA_KIND,
            messageId: "agent-message-1",
            sessionId: "session-1",
            text: "done",
        };

        expect(decodeAgentMessageDeltaEvent(JSON.stringify(event))).toEqual(event);
    });
});

describe("session cancel protocol", () => {
    it("Given an active turn identity, When cancellation crosses the relay boundary, Then only that turn is addressed", () => {
        const command: SessionCancelCommand = {
            commandId: "command-1",
            kind: SESSION_CANCEL_KIND,
            sessionId: "session-1",
        };

        expect(decodeSessionCancelCommand(encodeSessionCancelCommand(command))).toEqual(command);
    });

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
