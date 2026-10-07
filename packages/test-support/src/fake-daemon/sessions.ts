import * as p from "@moxt-ai/mobius-protocol";
import type { FakeDaemonOptions, Output, ReplyPlan, Session } from "./model.ts";
import { appendOutput } from "./turn-output.ts";

/** The sole owner of session, active-turn, queue and historical state. */
export class FakeSessions {
    readonly #lastText = new Map<string, Extract<p.RecordedSessionEvent, { readonly kind: "agent.message.delta" }>>();
    readonly #lastTextV2 = new Map<string, p.SessionEventV2>();
    readonly #sessions = new Map<string, Session>();
    readonly #send: (message: string) => void;
    readonly #options: FakeDaemonOptions;
    constructor(send: (message: string) => void, options: FakeDaemonOptions) {
        this.#send = send;
        this.#options = options;
    }
    readonly get = (id: string): Session | undefined => this.#sessions.get(id);
    readonly replayLastText = (prompt: string): void => {
        const match = [...this.#sessions.values()].find(
            (session) =>
                session.execution.kind === "running" &&
                session.execution.turn.messages.some((message) => message.role === "user" && message.text === prompt),
        );
        const event = match === undefined ? undefined : this.#lastText.get(match.metadata.sessionId);
        if (event === undefined) {
            throw new Error("No text to replay for this running prompt");
        }
        this.#send(
            p.encodeSessionEventEnvelope({
                kind: "session.event",
                sessionId: event.sessionId,
                payload: p.encodeRecordedSessionEvent(event),
            }),
        );
        const eventV2 = this.#lastTextV2.get(event.sessionId);
        if (eventV2 === undefined) {
            throw new Error("No V2 text to replay for this running prompt");
        }
        this.#send(p.encodeSessionEventEnvelopeV2({ event: eventV2, kind: "session.event.v2" }));
    };
    readonly continueReply = (prompt: string, plan: ReplyPlan): void => {
        const matches = [...this.#sessions.values()].filter(
            (session) =>
                session.execution.kind === "running" &&
                session.execution.turn.messages.some((message) => message.role === "user" && message.text === prompt),
        );
        const session = matches[0];
        if (matches.length !== 1 || session === undefined) {
            throw new Error("Expected exactly one running fake reply for this prompt");
        }
        for (const output of plan.output) {
            this.#output(session.metadata.sessionId, output);
        }
        if (plan.outcome === "complete") {
            this.#finish(session.metadata.sessionId, "end_turn");
        }
    };

    readonly prepare = (id: string, agentId = this.#options.agentId ?? "codex", directoryId = "default"): Session => {
        const existing = this.get(id);
        if (existing !== undefined) {
            return existing;
        }
        const session: Session = {
            metadata: {
                sessionId: id,
                agentId,
                directoryId,
                directoryLabel: "Fake workspace",
                additionalDirectories: [],
                prompted: false,
                title: "New chat",
                updatedAt: "2026-01-01T00:00:00Z",
            },
            history: [],
            eventsV2: [],
            execution: { kind: "idle" },
        };
        this.#sessions.set(id, session);
        return session;
    };
    readonly event = (sessionId: string, event: p.RecordedSessionEvent): void => {
        this.#send(
            p.encodeSessionEventEnvelope({
                kind: "session.event",
                sessionId,
                payload: p.encodeRecordedSessionEvent(event),
            }),
        );
        for (const payload of this.#v2Payloads(event)) {
            const recorded = this.#eventV2(sessionId, payload);
            if (event.kind === "agent.message.delta") {
                this.#lastTextV2.set(sessionId, recorded);
            }
        }
    };
    #eventV2(sessionId: string, payload: p.SessionEventPayloadV2): p.SessionEventV2 {
        const session = this.prepare(sessionId);
        const recorded: p.SessionEventV2 = {
            eventId: crypto.randomUUID(),
            ...payload,
            position: (session.eventsV2.length + 1).toString(),
            provenance: { kind: "original" },
            recordedAt: "2026-01-01T00:00:00.000Z",
            sessionId,
        };
        this.#sessions.set(sessionId, { ...session, eventsV2: [...session.eventsV2, recorded] });
        this.#send(p.encodeSessionEventEnvelopeV2({ event: recorded, kind: "session.event.v2" }));
        return recorded;
    }
    #v2Payloads(event: p.RecordedSessionEvent): readonly p.SessionEventPayloadV2[] {
        switch (event.kind) {
            case "session.started":
                return [
                    {
                        payload: {
                            attemptId: event.attemptId,
                            commandId: event.commandId,
                            epoch: event.epoch,
                            kind: "prompt.started",
                        },
                        type: "lifecycle-metadata",
                    },
                ];
            case "session.completed":
                return [
                    {
                        payload: { commandId: event.commandId, kind: "prompt.completed", stopReason: event.stopReason },
                        type: "lifecycle-metadata",
                    },
                ];
            case "session.failed":
                return [
                    {
                        payload: {
                            code: event.code,
                            commandId: event.commandId,
                            kind: "prompt.failed-before-start",
                            message: event.message,
                        },
                        type: "lifecycle-metadata",
                    },
                ];
            case "agent.message.delta":
                return [
                    {
                        payload: {
                            content: { text: event.text, type: "text" },
                            messageId: event.messageId,
                            sessionUpdate: "agent_message_chunk",
                        },
                        type: "acp",
                    },
                ];
            case "agent.content":
                return [
                    {
                        payload: {
                            content: {
                                description: event.content.text,
                                mimeType: event.content.mimeType,
                                name: event.content.name || event.content.uri,
                                type: "resource_link",
                                uri: event.content.uri,
                            },
                            messageId: event.messageId,
                            sessionUpdate: "agent_message_chunk",
                        },
                        type: "acp",
                    },
                ];
            case "agent.activity":
                return event.activityType === "reasoning"
                    ? [
                          {
                              payload: {
                                  content: { text: event.output, type: "text" },
                                  messageId: event.activityId,
                                  sessionUpdate: "agent_thought_chunk",
                              },
                              type: "acp",
                          },
                      ]
                    : [
                          {
                              payload: {
                                  kind: event.toolKind === "read" ? "read" : "other",
                                  name: event.name,
                                  rawInput: event.input,
                                  rawOutput: event.output,
                                  sessionUpdate: "tool_call",
                                  status:
                                      event.status === "completed"
                                          ? "completed"
                                          : event.status === "failed"
                                            ? "failed"
                                            : event.status === "pending"
                                              ? "pending"
                                              : "in_progress",
                                  title: event.title,
                                  toolCallId: event.activityId,
                              },
                              type: "acp",
                          },
                      ];
            case "session.queue.changed":
                return [{ payload: { kind: "session.queue.changed" }, type: "lifecycle-metadata" }];
            default:
                return [];
        }
    }
    #fail(command: p.SessionPromptCommand, code: string): void {
        this.event(command.sessionId, {
            kind: "session.failed",
            sessionId: command.sessionId,
            commandId: command.commandId,
            code,
            message: "The fake daemon rejected the prompt",
        });
    }
    readonly prompt = (command: p.SessionPromptCommand): void => {
        const session = this.prepare(command.sessionId, command.agentId, command.directoryId);
        const content = [
            ...(command.prompt.length === 0 ? [] : [{ text: command.prompt, type: "text" as const }]),
            ...command.images.map((image) => ({
                _meta: { mobius: { name: image.name } },
                data: image.data,
                mimeType: image.mimeType,
                type: "image" as const,
            })),
        ];
        this.#eventV2(command.sessionId, {
            payload: { commandId: command.commandId, content, kind: "prompt.requested" },
            type: "lifecycle-metadata",
        });
        const current = session.execution.kind === "running" ? session.execution.turn.commandIds[0] : undefined;
        const targetCompleted = session.history.some((turn) => turn.commandIds.includes(command.targetCommandId));
        if (command.disposition === "queue" && current !== command.targetCommandId && !targetCompleted) {
            this.#fail(command, "prompt_queue_target_unavailable");
            return;
        }
        if (command.disposition === "steer" && current !== command.targetCommandId) {
            this.#fail(command, "session_busy");
            return;
        }
        if (session.execution.kind === "idle") {
            this.#start(command, []);
            return;
        }
        switch (command.disposition) {
            case "reject":
                this.#fail(command, "session_busy");
                return;
            case "steer":
                this.#steer(command);
                return;
            case "queue":
                this.#sessions.set(command.sessionId, {
                    ...session,
                    execution: { ...session.execution, queued: [...session.execution.queued, command] },
                });
                this.#send(
                    p.encodeSessionQueuedEvent({
                        kind: "session.queued",
                        sessionId: command.sessionId,
                        commandId: command.commandId,
                    }),
                );
                this.event(command.sessionId, { kind: "session.queue.changed", sessionId: command.sessionId });
                return;
            default:
                throw new Error(`Unsupported prompt disposition: ${command.disposition}`);
        }
    };
    #start(command: p.SessionPromptCommand, queued: readonly p.SessionPromptCommand[]): void {
        const session = this.prepare(command.sessionId, command.agentId, command.directoryId);
        this.#sessions.set(command.sessionId, {
            ...session,
            metadata: {
                ...session.metadata,
                prompted: true,
                title: session.metadata.prompted ? session.metadata.title : command.prompt,
            },
            execution: {
                kind: "running",
                queued,
                turn: {
                    commandIds: [command.commandId],
                    epoch: command.commandId,
                    sequence: 0,
                    messages: [{ id: command.commandId, role: "user", text: command.prompt, images: command.images }],
                },
            },
        });
        this.#started(command, command.commandId);
        const plan = this.#options.reply(command.prompt, session.history.length + 1, "prompt");
        for (const output of plan.output) {
            this.#output(command.sessionId, output);
        }
        if (plan.outcome === "complete") {
            this.#finish(command.sessionId, "end_turn");
        }
    }
    #started(command: p.SessionPromptCommand, epoch: string): void {
        this.event(command.sessionId, {
            kind: "session.started",
            sessionId: command.sessionId,
            commandId: command.commandId,
            attemptId: crypto.randomUUID(),
            epoch,
            sequence: 0,
            prompt: command.prompt,
        });
    }
    #output(id: string, output: Output): void {
        const session = this.prepare(id);
        if (session.execution.kind !== "running") {
            throw new Error("No active turn");
        }
        const result = appendOutput(session.execution.turn, id, output);
        this.#sessions.set(id, { ...session, execution: { ...session.execution, turn: result.turn } });
        if (result.event.kind === "agent.message.delta") {
            this.#lastText.set(id, result.event);
        }
        this.event(id, result.event);
    }
    #finish(id: string, stopReason: string): void {
        const session = this.prepare(id);
        if (session.execution.kind !== "running") {
            return;
        }
        const { turn, queued } = session.execution;
        this.#sessions.set(id, { ...session, history: [...session.history, turn], execution: { kind: "idle" } });
        for (const commandId of turn.commandIds) {
            this.event(id, { kind: "session.completed", sessionId: id, commandId, stopReason });
        }
        const [next, ...remaining] = queued;
        if (next !== undefined) {
            this.#start(next, remaining);
        }
    }
    readonly cancel = (command: p.SessionCancelCommand): void => {
        const session = this.get(command.sessionId);
        if (session?.execution.kind !== "running") {
            return;
        }
        if (session.execution.turn.commandIds.includes(command.commandId)) {
            this.#finish(command.sessionId, "cancelled");
            return;
        }
        if (!session.execution.queued.some((q) => q.commandId === command.commandId)) {
            return;
        }
        this.#sessions.set(command.sessionId, {
            ...session,
            execution: {
                ...session.execution,
                queued: session.execution.queued.filter((q) => q.commandId !== command.commandId),
            },
        });
        this.event(command.sessionId, {
            kind: "session.completed",
            sessionId: command.sessionId,
            commandId: command.commandId,
            stopReason: "cancelled",
        });
        this.event(command.sessionId, { kind: "session.queue.changed", sessionId: command.sessionId });
    };
    readonly steerQueued = (command: p.SessionPromptDispositionCommand): void => {
        const session = this.get(command.sessionId);
        if (session?.execution.kind !== "running") {
            return;
        }
        const queued = session.execution.queued.find((q) => q.commandId === command.commandId);
        if (queued !== undefined) {
            this.#steer(queued);
        }
    };
    #steer(command: p.SessionPromptCommand): void {
        const session = this.prepare(command.sessionId);
        if (session.execution.kind !== "running") {
            throw new Error("No active turn");
        }
        const turn = session.execution.turn;
        this.#sessions.set(command.sessionId, {
            ...session,
            execution: {
                ...session.execution,
                queued: session.execution.queued.filter((q) => q.commandId !== command.commandId),
                turn: {
                    ...turn,
                    messages: [
                        ...turn.messages,
                        { id: command.commandId, role: "user", text: command.prompt, images: command.images },
                    ],
                },
            },
        });
        this.#started(command, turn.epoch);
        this.event(command.sessionId, { kind: "session.queue.changed", sessionId: command.sessionId });
        this.event(command.sessionId, {
            commandId: command.commandId,
            kind: "session.completed",
            sessionId: command.sessionId,
            stopReason: "steered",
        });
        const plan = this.#options.reply(command.prompt, session.history.length + 1, "steer");
        for (const output of plan.output) {
            this.#output(command.sessionId, output);
        }
        if (plan.outcome === "complete") {
            this.#finish(command.sessionId, "end_turn");
        }
    }
}
