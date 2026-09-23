import {
    AGENT_SETTINGS_DISCOVER_KIND,
    decodeAgentSettingsDiscoverCommand,
    decodeFileReadCommand,
    decodeMessageKind,
    decodeNativeSessionCommand,
    decodeRuntimeDelivery,
    decodeRuntimeHeartbeatEvent,
    decodeSessionEventAcknowledgement,
    decodeSessionEventDeferred,
    decodeSessionEventRejection,
    decodeSessionLiveHistoryLoad,
    decodeSessionLiveHistoryPageLoad,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    decodeSessionStartedEvent,
    decodeWorkspaceListCommand,
    encodeAgentActivityEvent,
    encodeAgentContentEvent,
    encodeAgentMessageDeltaEvent,
    encodeAgentSettingsDiscoveredEvent,
    encodeDaemonToServiceMessage,
    encodeFileBeginEvent,
    encodeFileChunkEvent,
    encodeFileEndEvent,
    encodeNativeSessionResult,
    encodeRuntimeDeliveryReceived,
    encodeRuntimeHeartbeatAckEvent,
    encodeSessionCompletedEvent,
    encodeSessionEventEnvelope,
    encodeSessionFailedEvent,
    encodeSessionLiveHistoryLoaded,
    encodeSessionLiveHistoryPageLoaded,
    encodeSessionOperationFailedEvent,
    encodeSessionReadyEvent,
    encodeSessionStartedEvent,
    encodeWorkspaceEntriesEvent,
    FILE_READ_KIND,
    NATIVE_SESSION_REQUEST_KIND,
    type NativeSessionHistory,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_HEARTBEAT_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_DEFERRED_KIND,
    SESSION_EVENT_KIND,
    SESSION_EVENT_REJECTED_KIND,
    SESSION_LIVE_HISTORY_LOAD_KIND,
    SESSION_LIVE_HISTORY_PAGE_LOAD_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    SESSION_STARTED_KIND,
    type SessionReadyEvent,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";

interface SocketEvent {
    readonly code?: number;
    readonly data?: unknown;
    readonly error?: unknown;
    readonly reason?: string;
}

export interface AgentDaemonSocket {
    readonly readyState: number;
    addEventListener(type: string, listener: (event: SocketEvent) => void, options?: { readonly once?: boolean }): void;
    close(code?: number, reason?: string): void;
    removeEventListener(type: string, listener: (event: SocketEvent) => void): void;
    send(data: string): void;
    readonly sendBatch?: (data: readonly string[]) => Promise<void>;
    readonly terminate?: () => void;
}

interface PendingMessage {
    readonly accepts: (message: string) => boolean;
    readonly kind: string;
    readonly priority: number;
    readonly reject: (reason: Error) => void;
    readonly resolve: (message: string) => void;
}

async function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
        const cleanup = (): void => signal.removeEventListener("abort", abort);
        const abort = (): void => {
            cleanup();
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        void operation.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error: unknown) => {
                cleanup();
                reject(error);
            },
        );
    });
}

/**
 * Per-Runtime event-source state that outlives a single connection. The real daemon keeps its Attempt
 * identities and per-source sequences in a durable outbox, so a reconnecting Runtime continues its
 * source sequences instead of restarting them. Sharing this record across reconnections keeps the fake
 * daemon contiguous the same way, which is what the Relay requires of the source it already recorded.
 */
export class FakeAgentDaemonState {
    readonly attemptIdsByCommand = new Map<string, string>();
    readonly sourceSequences = new Map<string, number>();
}

/** A stateful peer at the public daemon/server protocol boundary. */
export class FakeAgentDaemon implements AsyncDisposable {
    readonly #closed: Promise<void>;
    #closeCode = 1006;
    #closeReason = "Connection closed unexpectedly";
    readonly #messages: string[] = [];
    readonly #pending: PendingMessage[] = [];
    readonly #socket: AgentDaemonSocket;
    readonly #state: FakeAgentDaemonState;

    private constructor(socket: AgentDaemonSocket, state: FakeAgentDaemonState) {
        this.#socket = socket;
        this.#state = state;
        this.#closed = new Promise((resolve) => {
            if (socket.readyState === 3) {
                resolve();
                return;
            }
            socket.addEventListener(
                "close",
                (event) => {
                    this.#closeCode = event.code ?? 1006;
                    this.#closeReason = event.reason ?? "Connection closed unexpectedly";
                    for (const pending of this.#pending.splice(0)) {
                        pending.reject(
                            new Error(
                                `The fake Agent-daemon connection closed (${this.#closeCode.toString()}): ${this.#closeReason}`,
                            ),
                        );
                    }
                    resolve();
                },
                { once: true },
            );
        });
        socket.addEventListener("message", (event) => {
            const message = event.data;
            if (typeof message !== "string") {
                return;
            }
            const kind = decodeMessageKind(message);
            let pendingIndex = this.#pending.findIndex(
                (candidate) => candidate.kind === kind && candidate.accepts(message),
            );
            if (pendingIndex < 0) {
                pendingIndex = this.#pending.reduce(
                    (best, candidate, index) =>
                        candidate.kind === "*" &&
                        candidate.accepts(message) &&
                        (best < 0 || candidate.priority > (this.#pending[best]?.priority ?? -1))
                            ? index
                            : best,
                    -1,
                );
            }
            const pending = pendingIndex < 0 ? undefined : this.#pending.splice(pendingIndex, 1)[0];
            if (pending === undefined) {
                this.#messages.push(message);
                return;
            }
            pending.resolve(message);
        });
        socket.addEventListener("error", () => {
            for (const pending of this.#pending.splice(0)) {
                pending.reject(new Error("The fake Agent-daemon WebSocket failed"));
            }
        });
    }

    static async connect(
        url: URL,
        createSocket: (url: URL) => AgentDaemonSocket,
        signal = AbortSignal.timeout(8_000),
        state: FakeAgentDaemonState = new FakeAgentDaemonState(),
    ): Promise<FakeAgentDaemon> {
        const socket = createSocket(url);
        await new Promise<void>((resolve, reject) => {
            const cleanup = (): void => {
                socket.removeEventListener("close", close);
                socket.removeEventListener("error", error);
                socket.removeEventListener("open", open);
                signal.removeEventListener("abort", abort);
            };
            const abort = (): void => {
                cleanup();
                reject(signal.reason);
            };
            const close = (): void => {
                cleanup();
                reject(new Error("The fake Agent-daemon WebSocket closed while opening"));
            };
            const error = (event: SocketEvent): void => {
                cleanup();
                const cause = event.error instanceof Error ? event.error : undefined;
                reject(new Error("The fake Agent-daemon WebSocket failed while opening", { cause }));
            };
            const open = (): void => {
                cleanup();
                resolve();
            };
            socket.addEventListener("close", close, { once: true });
            socket.addEventListener("error", error, { once: true });
            socket.addEventListener("open", open, { once: true });
            signal.addEventListener("abort", abort, { once: true });
        });
        return new FakeAgentDaemon(socket, state);
    }

    readonly available = (kind: string): number =>
        this.#messages.filter((message) => decodeMessageKind(message) === kind).length;

    readonly close = (): void => this.#socket.close(1000, "Fake Agent-daemon complete");

    readonly waitForClose = async (signal: AbortSignal): Promise<void> => await waitFor(this.#closed, signal);

    readonly unexpectedClose = async (signal: AbortSignal): Promise<never> => {
        await this.waitForClose(signal);
        throw new Error(
            `The fake Agent-daemon connection closed (${this.#closeCode.toString()}): ${this.#closeReason}`,
        );
    };

    readonly receive = (
        kind: string,
        cancellation?: AbortSignal,
        accepts: (message: string) => boolean = () => true,
    ): Promise<string> => {
        cancellation?.throwIfAborted();
        const existingIndex = this.#messages.findIndex(
            (message) => (kind === "*" || decodeMessageKind(message) === kind) && accepts(message),
        );
        if (existingIndex >= 0) {
            const message = this.#messages.splice(existingIndex, 1)[0];
            return message === undefined
                ? Promise.reject(new Error(`Missing queued ${kind} message`))
                : Promise.resolve(message);
        }
        return new Promise((resolve, reject) => {
            const pending: PendingMessage = {
                accepts,
                kind,
                priority: 1,
                reject: (error) => {
                    cancellation?.removeEventListener("abort", abort);
                    reject(error);
                },
                resolve: (message) => {
                    cancellation?.removeEventListener("abort", abort);
                    resolve(message);
                },
            };
            const abort = (): void => {
                const index = this.#pending.indexOf(pending);
                if (index >= 0) {
                    this.#pending.splice(index, 1);
                }
                reject(cancellation?.reason);
            };
            this.#pending.push(pending);
            cancellation?.addEventListener("abort", abort, { once: true });
            if (cancellation?.aborted === true) {
                abort();
            }
        });
    };

    readonly receiveAny = (cancellation: AbortSignal): Promise<string> => {
        cancellation.throwIfAborted();
        const existing = this.#messages.shift();
        if (existing !== undefined) {
            return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
            const pending: PendingMessage = {
                accepts: () => true,
                kind: "*",
                priority: 0,
                reject: (error) => {
                    cancellation.removeEventListener("abort", abort);
                    reject(error);
                },
                resolve: (message) => {
                    cancellation.removeEventListener("abort", abort);
                    resolve(message);
                },
            };
            const abort = (): void => {
                const index = this.#pending.indexOf(pending);
                if (index >= 0) {
                    this.#pending.splice(index, 1);
                }
                reject(cancellation.reason);
            };
            this.#pending.push(pending);
            cancellation.addEventListener("abort", abort, { once: true });
        });
    };

    readonly send = (message: string): void => this.#socket.send(message);

    readonly sendBatch = async (messages: readonly string[]): Promise<void> => {
        if (this.#socket.sendBatch === undefined) {
            for (const message of messages) {
                this.#socket.send(message);
            }
            return;
        }
        await this.#socket.sendBatch(messages);
    };

    readonly sendSessionEvent = async (sessionId: string, payload: string, signal?: AbortSignal): Promise<string> => {
        signal?.throwIfAborted();
        const eventId = crypto.randomUUID();
        if (decodeMessageKind(payload) === SESSION_STARTED_KIND) {
            const started = decodeSessionStartedEvent(payload);
            this.#state.attemptIdsByCommand.set(`${sessionId}:${started.commandId}`, started.attemptId);
        }
        const decoded: unknown = JSON.parse(payload);
        const commandId =
            typeof decoded === "object" &&
            decoded !== null &&
            !Array.isArray(decoded) &&
            typeof Reflect.get(decoded, "commandId") === "string"
                ? String(Reflect.get(decoded, "commandId"))
                : undefined;
        const attemptId =
            commandId === undefined ? undefined : this.#state.attemptIdsByCommand.get(`${sessionId}:${commandId}`);
        const sourceKey = attemptId === undefined ? `runtime:${sessionId}` : `attempt:${sessionId}:${attemptId}`;
        const sourceSequence = (this.#state.sourceSequences.get(sourceKey) ?? 0) + 1;
        this.#state.sourceSequences.set(sourceKey, sourceSequence);
        const envelope = encodeSessionEventEnvelope({
            eventId,
            kind: SESSION_EVENT_KIND,
            payload,
            sessionId,
            source:
                attemptId === undefined
                    ? { kind: "runtime", sourceSeq: sourceSequence.toString() }
                    : { attemptId, kind: "attempt", sourceSeq: sourceSequence.toString() },
        });
        while (true) {
            const response = this.receive("*", signal, (message) => {
                const kind = decodeMessageKind(message);
                if (kind === SESSION_EVENT_ACK_KIND) {
                    const candidate = decodeSessionEventAcknowledgement(message);
                    return candidate.eventId === eventId && candidate.sessionId === sessionId;
                }
                if (kind === SESSION_EVENT_DEFERRED_KIND) {
                    const candidate = decodeSessionEventDeferred(message);
                    return candidate.eventId === eventId && candidate.sessionId === sessionId;
                }
                if (kind === SESSION_EVENT_REJECTED_KIND) {
                    const candidate = decodeSessionEventRejection(message);
                    return candidate.eventId === eventId && candidate.sessionId === sessionId;
                }
                return false;
            });
            this.#socket.send(envelope);
            const encoded = await response;
            const kind = decodeMessageKind(encoded);
            if (kind === SESSION_EVENT_DEFERRED_KIND) {
                const deferred = decodeSessionEventDeferred(encoded);
                await waitFor(
                    new Promise<void>((resolve) => setTimeout(resolve, deferred.retryAfterMilliseconds)),
                    signal ?? AbortSignal.timeout(20_000),
                );
                continue;
            }
            if (kind === SESSION_EVENT_REJECTED_KIND) {
                const rejection = decodeSessionEventRejection(encoded);
                throw new Error(`The server rejected the Session event: ${rejection.code}`);
            }
            return decodeSessionEventAcknowledgement(encoded).sequence;
        }
    };

    async [Symbol.asyncDispose](): Promise<void> {
        if (this.#socket.terminate === undefined) {
            this.close();
        } else {
            this.#socket.terminate();
        }
        await this.#closed;
    }
}

const imagePath = "/fake/generated-image.png";
const sourcePath = "/fake/generated-source.ts";
const imageBytes = Uint8Array.from(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
    ),
);
const sourceBytes = new TextEncoder().encode("export const generated = true;\n");

export interface FakeAgentDaemonBehavior {
    readonly agentId?: "codex" | "claude" | "opencode" | "pi";
    readonly agentName?: string;
    readonly afterSessionStarted?: (signal: AbortSignal) => Promise<void>;
    readonly directoryLabel?: string;
    readonly nativeSessionIds?: ReadonlySet<string>;
    readonly loadNativeHistory?: (sessionId: string, signal: AbortSignal) => Promise<NativeSessionHistory>;
    readonly requiredBindingId?: string;
}

export interface RunningFakeAgentDaemon extends AsyncDisposable {
    /** Rejects when the fake cannot continue serving the protocol. */
    readonly failure: Promise<never>;
}

async function sendFile(daemon: FakeAgentDaemon, encoded: string): Promise<void> {
    const command = decodeFileReadCommand(encoded);
    const source = command.path === sourcePath;
    const bytes = source ? sourceBytes : imageBytes;
    await daemon.sendBatch([
        encodeFileBeginEvent({
            byteLength: bytes.byteLength,
            kind: "file.begin",
            mediaType: source ? "text/typescript" : "image/png",
            modifiedAt: "2026-01-01T00:00:00.000Z",
            name: source ? "generated-source.ts" : "generated-image.png",
            requestId: command.requestId,
            sessionId: command.sessionId,
        }),
        encodeFileChunkEvent({
            data: Buffer.from(bytes).toString("base64"),
            kind: "file.chunk",
            requestId: command.requestId,
            sequence: 0,
            sessionId: command.sessionId,
        }),
        encodeFileEndEvent({
            kind: "file.end",
            requestId: command.requestId,
            sessionId: command.sessionId,
        }),
    ]);
}

async function processHappyPathCommand(
    daemon: FakeAgentDaemon,
    encoded: string,
    behavior: FakeAgentDaemonBehavior,
    nextTurn: () => number,
    signal: AbortSignal,
): Promise<void> {
    const kind = decodeMessageKind(encoded);
    if (kind === RUNTIME_DELIVERY_KIND) {
        const delivery = decodeRuntimeDelivery(encoded);
        daemon.send(
            encodeRuntimeDeliveryReceived({
                deliveryId: delivery.deliveryId,
                kind: "runtime.delivery.received",
                sessionId: delivery.sessionId,
            }),
        );
        await processHappyPathCommand(daemon, delivery.payload, behavior, nextTurn, signal);
        return;
    }
    if (kind === RUNTIME_HEARTBEAT_KIND) {
        const heartbeat = decodeRuntimeHeartbeatEvent(encoded);
        daemon.send(
            encodeRuntimeHeartbeatAckEvent({
                heartbeatId: heartbeat.heartbeatId,
                kind: "runtime.heartbeat.ack",
            }),
        );
        return;
    }
    if (kind === WORKSPACE_LIST_KIND) {
        const command = decodeWorkspaceListCommand(encoded);
        daemon.send(
            encodeWorkspaceEntriesEvent({
                bindingId: command.bindingId,
                directoryId: command.directoryId,
                directoryLabel: behavior.directoryLabel ?? "Fake workspace",
                entries: [],
                kind: WORKSPACE_ENTRIES_KIND,
                parentDirectoryId: "",
                requestId: command.requestId,
            }),
        );
        return;
    }
    if (kind === AGENT_SETTINGS_DISCOVER_KIND) {
        const command = decodeAgentSettingsDiscoverCommand(encoded);
        daemon.send(
            encodeAgentSettingsDiscoveredEvent({
                agentId: command.agentId,
                agentName: behavior.agentName ?? "Fake Agent",
                agentVersion: "fake-agent-daemon",
                kind: "agent.settings.discovered",
                modelEffort: {
                    effortSettingId: "",
                    modelSettingId: "model",
                    resolution: "complete",
                    unsupportedModelIds: [],
                    valuesByModel: { "test-large": [], "test-small": [] },
                },
                requestId: command.requestId,
                settings: [
                    {
                        booleanValue: false,
                        category: "model",
                        defaultValue: "test-small",
                        description: "Model used by the fake Agent-daemon",
                        id: "model",
                        name: "Model",
                        type: "select",
                        values: [
                            {
                                description: "Small deterministic test model",
                                groupId: "models",
                                groupName: "Models",
                                name: "Test Small",
                                value: "test-small",
                            },
                            {
                                description: "Large deterministic test model",
                                groupId: "models",
                                groupName: "Models",
                                name: "Test Large",
                                value: "test-large",
                            },
                        ],
                    },
                ],
                settingsRevision: "0".repeat(64),
            }),
        );
        return;
    }
    if (kind === NATIVE_SESSION_REQUEST_KIND) {
        const command = decodeNativeSessionCommand(encoded);
        if (command.action === "create") {
            daemon.send(
                encodeNativeSessionResult({
                    action: "create",
                    kind: "native.session.result",
                    nativeSessionId:
                        behavior.agentId === "opencode"
                            ? `ses_${crypto.randomUUID().replaceAll("-", "")}`
                            : crypto.randomUUID(),
                    requestId: command.requestId,
                    sessionId: command.sessionId,
                }),
            );
        } else if (command.action === "find" && behavior.nativeSessionIds?.has(command.nativeSessionId)) {
            daemon.send(
                encodeNativeSessionResult({
                    action: "find",
                    entry: {
                        entryId: command.nativeSessionId,
                        nativeSessionId: command.nativeSessionId,
                        directoryId: "default",
                        directoryLabel: behavior.directoryLabel ?? "Fake workspace",
                        additionalDirectories: [],
                        title: "New chat",
                        updatedAt: null,
                    },
                    kind: "native.session.result",
                    requestId: command.requestId,
                    sessionId: command.sessionId,
                }),
            );
        } else if (command.action === "linked-history" && behavior.loadNativeHistory !== undefined) {
            const history = await behavior.loadNativeHistory(command.targetSessionId, signal);
            signal.throwIfAborted();
            daemon.send(
                encodeNativeSessionResult({
                    action: "linked-history",
                    history,
                    kind: "native.session.result",
                    requestId: command.requestId,
                    sessionId: command.sessionId,
                    targetSessionId: command.targetSessionId,
                }),
            );
        } else {
            daemon.send(
                encodeSessionOperationFailedEvent({
                    code: "native_session_not_found",
                    kind: "session.operation.failed",
                    message: "The native session was not found",
                    requestId: command.requestId,
                    sessionId: command.sessionId,
                }),
            );
        }
        return;
    }
    if (kind === SESSION_PREPARE_KIND) {
        const command = decodeSessionPrepareCommand(encoded);
        const ready: SessionReadyEvent = {
            additionalDirectories: command.additionalDirectoryIds.map((directoryId) => ({
                directoryId,
                name: directoryId,
            })),
            agentId: command.agentId,
            agentName: behavior.agentName ?? "Fake Agent",
            agentVersion: "fake-agent-daemon",
            capabilities: {
                additionalDirectories: true,
                audioPrompt: false,
                closeSession: true,
                deleteSession: true,
                embeddedContextPrompt: true,
                imagePrompt: true,
                listSessions: true,
                loadSession: true,
                promptQueueing: false,
                resumeSession: true,
                steering: false,
                unstableForkSession: false,
            },
            commands: [],
            configOptions: [],
            directoryId: command.directoryId,
            directoryLabel: behavior.directoryLabel ?? "Fake workspace",
            kind: "session.ready",
            requestId: command.requestId,
            restored: false,
            sessionId: command.sessionId,
        };
        if (command.transient === true) {
            // An inspection-only preparation has no Session on the Relay, so the real daemon answers it
            // with a direct reply rather than a durable event, which could never commit. Sending it as a
            // Session event here would wait for an acknowledgement that can never arrive.
            daemon.send(encodeDaemonToServiceMessage(ready));
            return;
        }
        await daemon.sendSessionEvent(command.sessionId, encodeSessionReadyEvent(ready), signal);
        return;
    }
    if (kind === SESSION_LIVE_HISTORY_LOAD_KIND) {
        const command = decodeSessionLiveHistoryLoad(encoded);
        daemon.send(
            encodeSessionLiveHistoryLoaded({
                history: {
                    cause: {
                        code: "native_history_unsupported",
                        message: "The fake Agent daemon does not provide native message history.",
                    },
                    status: "unavailable",
                },
                kind: "session.live-history.loaded",
                requestId: command.requestId,
                sessionId: command.sessionId,
            }),
        );
        return;
    }
    if (kind === SESSION_LIVE_HISTORY_PAGE_LOAD_KIND) {
        const command = decodeSessionLiveHistoryPageLoad(encoded);
        daemon.send(
            encodeSessionLiveHistoryPageLoaded({
                kind: "session.live-history.page.loaded",
                page: {
                    cause: {
                        code: "native_history_unsupported",
                        message: "The fake Agent daemon does not provide native message history.",
                    },
                    nextCursor: null,
                    status: "unavailable",
                },
                requestId: command.requestId,
                sessionId: command.sessionId,
            }),
        );
        return;
    }
    if (kind === FILE_READ_KIND) {
        await sendFile(daemon, encoded);
        return;
    }
    if (kind !== SESSION_PROMPT_KIND) {
        return;
    }
    const command = decodeSessionPromptCommand(encoded);
    if (behavior.requiredBindingId !== undefined && command.bindingId !== behavior.requiredBindingId) {
        await daemon.sendSessionEvent(
            command.sessionId,
            encodeSessionFailedEvent({
                code: "binding_mismatch",
                commandId: command.commandId,
                kind: "session.failed",
                message: "The runtime binding is not authorized",
                sessionId: command.sessionId,
            }),
            signal,
        );
        return;
    }
    const turn = nextTurn();
    const createsImage = command.prompt.toLowerCase().includes("image");
    await daemon.sendSessionEvent(
        command.sessionId,
        encodeSessionStartedEvent({
            attemptId: `fake-attempt-${turn.toString()}`,
            commandId: command.commandId,
            kind: SESSION_STARTED_KIND,
            sessionId: command.sessionId,
        }),
        signal,
    );
    await behavior.afterSessionStarted?.(signal);
    const imageContent = createsImage
        ? {
              artifactId: "",
              data: "",
              mimeType: "image/png",
              name: "Generated image",
              newText: "",
              oldText: "",
              path: imagePath,
              terminalId: "",
              text: "",
              type: "image" as const,
              uri: imagePath,
          }
        : null;
    if (imageContent !== null) {
        await daemon.sendSessionEvent(
            command.sessionId,
            encodeAgentActivityEvent({
                activityId: `fake-image-${turn.toString()}`,
                activityType: "tool",
                commandId: command.commandId,
                content: [imageContent],
                detail: { content: [imageContent], input: command.prompt, kind: "recorded", output: imagePath },
                input: command.prompt,
                kind: "agent.activity",
                locations: [imagePath],
                name: "generate_image",
                output: imagePath,
                sequence: 0,
                sessionId: command.sessionId,
                status: "completed",
                title: "Generate image",
                toolKind: "other",
            }),
            signal,
        );
    }
    await daemon.sendSessionEvent(
        command.sessionId,
        encodeAgentMessageDeltaEvent({
            commandId: command.commandId,
            kind: "agent.message.delta",
            messageId: `fake-message-${turn.toString()}`,
            sessionId: command.sessionId,
            text: `${behavior.agentName ?? "Fake Agent"} turn ${turn.toString()}: ${command.prompt}${
                createsImage ? `\n\n[Generated source](<${sourcePath}:104>)` : ""
            }`,
        }),
        signal,
    );
    if (imageContent !== null) {
        await daemon.sendSessionEvent(
            command.sessionId,
            encodeAgentContentEvent({
                commandId: command.commandId,
                content: imageContent,
                contentId: `fake-image-content-${turn.toString()}`,
                kind: "agent.content",
                messageId: `fake-message-${turn.toString()}`,
                sessionId: command.sessionId,
            }),
            signal,
        );
    }
    await daemon.sendSessionEvent(
        command.sessionId,
        encodeSessionCompletedEvent({
            commandId: command.commandId,
            kind: "session.completed",
            sessionId: command.sessionId,
            stopReason: "end_turn",
        }),
        signal,
    );
}

export function serveFakeAgentDaemon(
    daemon: FakeAgentDaemon,
    behavior: FakeAgentDaemonBehavior = {},
): RunningFakeAgentDaemon {
    const cancellation = new AbortController();
    const failure = Promise.withResolvers<never>();
    const tasks = new Set<Promise<void>>();
    let turn = 0;
    const nextTurn = (): number => {
        turn += 1;
        return turn;
    };
    const start = (message: string): void => {
        const task = processHappyPathCommand(daemon, message, behavior, nextTurn, cancellation.signal);
        tasks.add(task);
        void task.then(
            () => tasks.delete(task),
            (error: unknown) => {
                tasks.delete(task);
                if (!cancellation.signal.aborted) {
                    failure.reject(error);
                    cancellation.abort(error);
                }
            },
        );
    };
    const running = (async () => {
        while (!cancellation.signal.aborted) {
            start(await daemon.receiveAny(cancellation.signal));
        }
    })();
    const disconnected = daemon.unexpectedClose(cancellation.signal);
    void running.catch((error: unknown) => {
        if (!cancellation.signal.aborted) {
            failure.reject(error);
        }
    });
    void disconnected.catch((error: unknown) => {
        if (!cancellation.signal.aborted) {
            failure.reject(error);
            cancellation.abort(error);
        }
    });
    void failure.promise.catch(() => undefined);
    return {
        failure: failure.promise,
        [Symbol.asyncDispose]: async () => {
            cancellation.abort(new Error("Fake Agent-daemon stopped"));
            try {
                await running;
            } catch {
                // Cancellation is the normal shutdown path. Real failures are exposed by `failure`.
            }
            await Promise.allSettled(tasks);
        },
    };
}
