import * as p from "@moxt-ai/mobius-protocol";

type History = Extract<p.NativeSessionHistory, { readonly status: "available" }>;
interface Session {
    readonly metadata: p.SessionMetadata;
    readonly turn: p.ActiveTurnSnapshot | null;
    readonly history: History;
}
const EMPTY_HISTORY: History = {
    status: "available",
    messages: [],
    truncated: false,
    coveredCommandIds: [],
    coveredMessageIds: [],
};

/** Recovery reads the state emitted by the peer. Product services and transports remain real. */
export class FakeAgentDaemonState {
    readonly #sessions = new Map<string, Session>();
    readonly #transient = new Set<string>();
    readonly #inspected = new Map<string, p.SessionReadyEvent>();
    readonly observe = (encoded: string): void => {
        const event = p.decodeDaemonToServiceMessage(encoded);
        if (event.kind !== "session.ready") {
            return;
        }
        if (this.#transient.delete(event.requestId)) {
            this.#inspected.set(event.sessionId, event);
            return;
        }
        const previous = this.#sessions.get(event.sessionId);
        this.#sessions.set(event.sessionId, {
            history: previous?.history ?? EMPTY_HISTORY,
            turn: previous?.turn ?? null,
            metadata: {
                sessionId: event.sessionId,
                agentId: event.agentId,
                directoryId: event.directoryId,
                directoryLabel: event.directoryLabel,
                additionalDirectories: event.additionalDirectories,
                prompted: previous?.metadata.prompted ?? false,
                status: previous?.metadata.status ?? { kind: "idle" },
                title: previous?.metadata.title ?? "New chat",
                updatedAt: previous?.metadata.updatedAt ?? "2026-01-01T00:00:00.000Z",
            },
        });
    };
    readonly record = (sessionId: string, encoded: string): void => {
        const event = p.decodeRecordedSessionEvent(encoded);
        if (event.kind === "session.ready") {
            this.observe(p.encodeDaemonToServiceMessage(event));
            return;
        }
        const inspected = this.#inspected.get(sessionId);
        if (!this.#sessions.has(sessionId) && inspected !== undefined) {
            this.observe(p.encodeDaemonToServiceMessage(inspected));
        }
        const session = this.#sessions.get(sessionId);
        if (session === undefined) {
            throw new Error("Emit session.ready before Session events");
        }
        if (event.kind === "session.info.updated") {
            this.#sessions.set(sessionId, {
                ...session,
                metadata: {
                    ...session.metadata,
                    title: event.title || session.metadata.title,
                    updatedAt: event.updatedAt ?? session.metadata.updatedAt,
                },
            });
        } else if (event.kind === "session.started") {
            this.#sessions.set(sessionId, {
                ...session,
                metadata: {
                    ...session.metadata,
                    prompted: true,
                    updatedAt: new Date().toISOString(),
                    title: session.metadata.prompted
                        ? session.metadata.title
                        : p.conversationTitleFromText(event.prompt),
                    status: { kind: "working", commandId: event.commandId },
                },
                turn: {
                    commandId: event.commandId,
                    epoch: event.epoch,
                    hasOlder: false,
                    interaction: null,
                    messages: [{ id: event.commandId, role: "user", text: event.prompt }],
                    sequence: 0,
                    state: "running",
                    truncated: false,
                },
            });
        } else if (session.turn !== null) {
            const turn = session.turn;
            if (event.kind === "session.completed" || event.kind === "session.failed") {
                const messages = turn.messages.map(
                    (m): p.NativeHistoryMessage =>
                        m.role === "user"
                            ? { role: "user", text: m.text }
                            : { role: "assistant", text: m.text, activities: m.activities, content: m.content },
                );
                this.#sessions.set(sessionId, {
                    ...session,
                    turn: null,
                    metadata: { ...session.metadata, status: { kind: "idle" } },
                    history: {
                        ...session.history,
                        messages: [...session.history.messages, ...messages],
                        coveredCommandIds: [...session.history.coveredCommandIds, turn.commandId],
                        coveredMessageIds: [
                            ...session.history.coveredMessageIds,
                            `${turn.commandId}:user`,
                            `${turn.commandId}:agent`,
                        ],
                    },
                });
            } else if (
                event.kind === "agent.message.delta" ||
                event.kind === "agent.activity" ||
                event.kind === "agent.content"
            ) {
                const latest = turn.messages.at(-1);
                const assistant: Extract<p.ActiveTurnMessage, { readonly role: "assistant" }> =
                    latest?.role === "assistant"
                        ? latest
                        : { id: `${turn.commandId}:agent`, role: "assistant", text: "", activities: [], content: [] };
                const next =
                    event.kind === "agent.message.delta"
                        ? { ...assistant, text: assistant.text + event.text }
                        : event.kind === "agent.content"
                          ? { ...assistant, content: [...assistant.content, event.content] }
                          : {
                                ...assistant,
                                activities: [
                                    ...assistant.activities.filter((a) => a.activityId !== event.activityId),
                                    event,
                                ],
                            };
                this.#sessions.set(sessionId, {
                    ...session,
                    turn: {
                        ...turn,
                        sequence: turn.sequence + 1,
                        messages: [
                            ...(latest?.role === "assistant" ? turn.messages.slice(0, -1) : turn.messages),
                            next,
                        ],
                    },
                });
            } else if (
                event.kind === "session.permission.requested" ||
                event.kind === "session.elicitation.requested"
            ) {
                this.#sessions.set(sessionId, { ...session, turn: { ...turn, interaction: event } });
            } else if (event.kind === "session.permission.resolved" || event.kind === "session.elicitation.resolved") {
                this.#sessions.set(sessionId, { ...session, turn: { ...turn, interaction: null } });
            }
        }
    };
    readonly reply = (encoded: string, send: (encoded: string) => void): boolean => {
        const c = p.decodeServiceToDaemonMessage(encoded);
        switch (c.kind) {
            case "runtime.liveness.ready":
            case "runtime.heartbeat.ack":
                return true;
            case "session.prepare":
                if (c.transient === true) {
                    this.#transient.add(c.requestId);
                }
                return false;
            case "session.prompt": {
                if (!this.#sessions.has(c.sessionId)) {
                    this.#sessions.set(c.sessionId, {
                        history: EMPTY_HISTORY,
                        turn: null,
                        metadata: {
                            sessionId: c.sessionId,
                            agentId: c.agentId,
                            directoryId: c.directoryId,
                            directoryLabel: "mobius",
                            additionalDirectories: [],
                            prompted: false,
                            status: { kind: "idle" },
                            title: "New chat",
                            updatedAt: "2026-01-01T00:00:00.000Z",
                        },
                    });
                }
                return false;
            }
            case "session.list":
                send(
                    p.encodeSessionsListedEvent({
                        kind: "session.listed",
                        requestId: c.requestId,
                        entries: [...this.#sessions.values()].map((s) => s.metadata).slice(0, c.limit),
                    }),
                );
                return true;
            case "session.query":
                send(
                    p.encodeSessionsQueriedEvent({
                        kind: "session.queried",
                        requestId: c.requestId,
                        entries: c.sessionIds.flatMap((id) => {
                            const s = this.#sessions.get(id);
                            return s === undefined ? [] : [s.metadata];
                        }),
                    }),
                );
                return true;
            case "native.session.request":
                if (c.action !== "active-turn") {
                    return false;
                }
                send(
                    p.encodeNativeSessionResult({
                        kind: "native.session.result",
                        action: "active-turn",
                        requestId: c.requestId,
                        sessionId: c.sessionId,
                        targetSessionId: c.targetSessionId,
                        turn: this.#sessions.get(c.targetSessionId)?.turn ?? null,
                        queued: [],
                    }),
                );
                return true;
            case "session.live-history.page.load": {
                const history = this.#sessions.get(c.sessionId)?.history ?? EMPTY_HISTORY;
                const end = c.cursor === null ? history.messages.length : Number(c.cursor);
                const start = Math.max(0, end - c.limit);
                send(
                    p.encodeSessionLiveHistoryPageLoaded({
                        kind: "session.live-history.page.loaded",
                        requestId: c.requestId,
                        sessionId: c.sessionId,
                        page: {
                            ...history,
                            messages: history.messages.slice(start, end),
                            nextCursor: start === 0 ? null : start.toString(),
                        },
                    }),
                );
                return true;
            }
            default:
                return false;
        }
    };
}
