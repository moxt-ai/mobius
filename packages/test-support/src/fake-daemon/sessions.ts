import * as p from "@moxt-ai/mobius-protocol";
import type { FakeDaemonOptions, Output, Session } from "./model.ts";
import { appendOutput } from "./turn-output.ts";

/** The sole owner of session, active-turn, queue and historical state. */
export class FakeSessions {
    readonly #sessions = new Map<string, Session>();
    readonly #send: (message: string) => void;
    readonly #options: FakeDaemonOptions;
    constructor(send: (message: string) => void, options: FakeDaemonOptions) {
        this.#send = send;
        this.#options = options;
    }
    readonly get = (id: string): Session | undefined => this.#sessions.get(id);
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
    };
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
                    commandIds: [...turn.commandIds, command.commandId],
                    messages: [
                        ...turn.messages,
                        { id: command.commandId, role: "user", text: command.prompt, images: command.images },
                    ],
                },
            },
        });
        this.#started(command, turn.epoch);
        this.event(command.sessionId, { kind: "session.queue.changed", sessionId: command.sessionId });
        const plan = this.#options.reply(command.prompt, session.history.length + 1, "steer");
        for (const output of plan.output) {
            this.#output(command.sessionId, output);
        }
        if (plan.outcome === "complete") {
            this.#finish(command.sessionId, "end_turn");
        }
    }
}
