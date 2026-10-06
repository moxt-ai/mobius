import * as p from "@moxt-ai/mobius-protocol";
import { fakeDaemonCapabilities, fakeSessionReady, settings } from "./catalog.ts";
import { activeTurn, eventHistoryPageV2, historyPage } from "./history.ts";
import type { FakeDaemonOptions, ReplyPlan } from "./model.ts";
import { FakeSessions } from "./sessions.ts";

/** JSON protocol boundary shared by Web, Worker and browser suites. */
export class FakeAgentDaemon {
    readonly #sessions: FakeSessions;
    readonly #send: (message: string) => void;
    readonly #options: FakeDaemonOptions;
    constructor(send: (message: string) => void, options: FakeDaemonOptions) {
        this.#send = send;
        this.#options = options;
        this.#sessions = new FakeSessions(send, options);
    }
    readonly replayLastText = (prompt: string): void => this.#sessions.replayLastText(prompt);
    readonly continueReply = (prompt: string, plan: ReplyPlan): void => this.#sessions.continueReply(prompt, plan);
    receive(encoded: string): void {
        const kind = p.decodeMessageKind(encoded);
        switch (kind) {
            case "runtime.liveness.ready":
                return;
            case "runtime.heartbeat": {
                const h = p.decodeRuntimeHeartbeatEvent(encoded);
                this.#send(
                    p.encodeRuntimeHeartbeatAckEvent({ kind: "runtime.heartbeat.ack", heartbeatId: h.heartbeatId }),
                );
                return;
            }
            case "session.prompt":
                this.#sessions.prompt(p.decodeSessionPromptCommand(encoded));
                return;
            case "session.cancel":
                this.#sessions.cancel(p.decodeSessionCancelCommand(encoded));
                return;
            case "session.prompt.disposition":
                this.#sessions.steerQueued(p.decodeSessionPromptDispositionCommand(encoded));
                return;
            case "workspace.list": {
                const c = p.decodeWorkspaceListCommand(encoded);
                this.#send(
                    p.encodeWorkspaceEntriesEvent({
                        kind: "workspace.entries",
                        requestId: c.requestId,
                        bindingId: c.bindingId,
                        directoryId: c.directoryId,
                        directoryLabel: "Fake workspace",
                        entries: [],
                        parentDirectoryId: "",
                    }),
                );
                return;
            }
            case "agent.settings.discover":
                this.#send(settings(p.decodeAgentSettingsDiscoverCommand(encoded), this.#options));
                return;
            case "session.prepare": {
                const c = p.decodeSessionPrepareCommand(encoded);
                this.#sessions.prepare(c.sessionId, c.agentId, c.directoryId);
                const ready = fakeSessionReady(c, this.#options, c.sessionId, false);
                if (c.transient === true) {
                    this.#send(p.encodeDaemonToServiceMessage(ready));
                } else {
                    this.#sessions.event(c.sessionId, ready);
                }
                return;
            }
            case "session.query": {
                const c = p.decodeSessionQueryCommand(encoded);
                this.#send(
                    p.encodeSessionsQueriedEvent({
                        kind: "session.queried",
                        requestId: c.requestId,
                        entries: c.sessionIds.flatMap((id) => {
                            const s = this.#sessions.get(id);
                            return s === undefined ? [] : [s.metadata];
                        }),
                    }),
                );
                return;
            }
            case "native.session.request":
                this.#native(p.decodeNativeSessionCommand(encoded));
                return;
            case "session.live-history.page.load": {
                const command = p.decodeSessionLiveHistoryPageLoad(encoded);
                this.#send(
                    p.encodeSessionLiveHistoryPageLoaded({
                        kind: "session.live-history.page.loaded",
                        requestId: command.requestId,
                        sessionId: command.sessionId,
                        page: historyPage(this.#sessions.prepare(command.sessionId), command.cursor, command.limit),
                    }),
                );
                return;
            }
            case "session.live-history.v2.page.load": {
                const command = p.decodeSessionLiveHistoryV2PageLoad(encoded);
                this.#send(
                    p.encodeSessionLiveHistoryV2PageLoaded({
                        events: eventHistoryPageV2(
                            this.#sessions.prepare(command.sessionId),
                            command.cursor,
                            command.eventLimit,
                        ),
                        kind: "session.live-history.v2.page.loaded",
                        requestId: command.requestId,
                        sessionId: command.sessionId,
                    }),
                );
                return;
            }
            default:
                throw new Error(`Unsupported fake daemon message: ${kind}`);
        }
    }
    #native(c: p.NativeSessionCommand): void {
        const envelope = { kind: "native.session.result", requestId: c.requestId, sessionId: c.sessionId } as const;
        switch (c.action) {
            case "create": {
                const id = crypto.randomUUID();
                this.#sessions.prepare(id, c.agentId, c.directoryId);
                this.#send(p.encodeNativeSessionResult({ ...envelope, action: "create", nativeSessionId: id }));
                return;
            }
            case "active-turn": {
                const session = this.#sessions.prepare(c.targetSessionId);
                this.#send(
                    p.encodeNativeSessionResult({
                        ...envelope,
                        action: "active-turn",
                        targetSessionId: c.targetSessionId,
                        queued:
                            session.execution.kind === "idle"
                                ? []
                                : session.execution.queued.map((q) => ({
                                      commandId: q.commandId,
                                      prompt: q.prompt,
                                      images: q.images,
                                  })),
                        turn: activeTurn(session),
                    }),
                );
                return;
            }
            case "list": {
                this.#send(
                    p.encodeNativeSessionResult({
                        ...envelope,
                        action: "list",
                        capabilities: fakeDaemonCapabilities,
                        nextCursor: null,
                        entries: [...(this.#options.nativeSessionIds ?? [])].map((id) => ({
                            entryId: id,
                            nativeSessionId: id,
                            mobiusSessionIds: [],
                            additionalDirectories: [],
                            directoryId: c.directoryId,
                            directoryLabel: "Fake workspace",
                            title: "Saved conversation",
                            updatedAt: "2026-01-01T00:00:00Z",
                        })),
                    }),
                );
                return;
            }
            case "find": {
                if (this.#options.nativeSessionIds?.has(c.nativeSessionId)) {
                    this.#send(
                        p.encodeNativeSessionResult({
                            ...envelope,
                            action: "find",
                            entry: {
                                entryId: c.nativeSessionId,
                                nativeSessionId: c.nativeSessionId,
                                mobiusSessionIds: [],
                                additionalDirectories: [],
                                directoryId: c.directoryId,
                                directoryLabel: "Fake workspace",
                                title: "Saved conversation",
                                updatedAt: "2026-01-01T00:00:00Z",
                            },
                        }),
                    );
                    return;
                }
                break;
            }
            case "import": {
                if (this.#options.nativeSessionIds?.has(c.entryId)) {
                    this.#sessions.prepare(c.entryId, c.agentId, c.directoryId);
                    this.#send(
                        p.encodeNativeSessionResult({
                            ...envelope,
                            action: c.action,
                            targetSessionId: c.targetSessionId,
                            title: "Saved conversation",
                            ready: fakeSessionReady(c, this.#options, c.entryId, true),
                        }),
                    );
                    return;
                }
                break;
            }
            case "fork": {
                if (this.#options.nativeSessionIds?.has(c.entryId)) {
                    this.#sessions.prepare(c.targetSessionId, c.agentId, c.directoryId);
                    this.#send(
                        p.encodeNativeSessionResult({
                            ...envelope,
                            action: c.action,
                            targetSessionId: c.targetSessionId,
                            title: "Saved conversation",
                            ready: fakeSessionReady(c, this.#options, c.targetSessionId, true),
                        }),
                    );
                    return;
                }
                break;
            }
            default:
                throw new Error(`Unsupported fake native operation: ${c.action}`);
        }
        this.#send(
            p.encodeSessionOperationFailedEvent({
                kind: "session.operation.failed",
                requestId: c.requestId,
                sessionId: c.sessionId,
                code: "native_session_not_found",
                message: "The native session was not found",
            }),
        );
    }
}
