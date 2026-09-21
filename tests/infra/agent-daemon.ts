import {
    decodeFileReadCommand,
    decodeMessageKind,
    decodeRuntimeDelivery,
    decodeRuntimeHeartbeatEvent,
    decodeSessionEventAcknowledgement,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    decodeSessionStartedEvent,
    decodeWorkspaceListCommand,
    encodeAgentActivityEvent,
    encodeAgentMessageDeltaEvent,
    encodeDaemonToServiceMessage,
    encodeFileBeginEvent,
    encodeFileChunkEvent,
    encodeFileEndEvent,
    encodeRuntimeDeliveryReceived,
    encodeRuntimeHeartbeatAckEvent,
    encodeSessionCompletedEvent,
    encodeSessionEventEnvelope,
    encodeSessionReadyEvent,
    encodeSessionStartedEvent,
    encodeWorkspaceEntriesEvent,
    FILE_READ_KIND,
    RUNTIME_DELIVERY_KIND,
    RUNTIME_HEARTBEAT_KIND,
    SESSION_EVENT_ACK_KIND,
    SESSION_EVENT_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    SESSION_STARTED_KIND,
    type SessionReadyEvent,
    WORKSPACE_ENTRIES_KIND,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";

interface SocketEvent {
    readonly data?: unknown;
}

export interface AgentDaemonSocket {
    readonly readyState: number;
    addEventListener(type: string, listener: (event: SocketEvent) => void, options?: { readonly once?: boolean }): void;
    close(code?: number, reason?: string): void;
    removeEventListener(type: string, listener: (event: SocketEvent) => void): void;
    send(data: string): void;
}

interface PendingMessage {
    readonly kind: string;
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

/** A stateful peer at the public daemon/server protocol boundary. */
export class FakeAgentDaemon implements AsyncDisposable {
    readonly #attemptIdsByCommand = new Map<string, string>();
    readonly #closed: Promise<void>;
    readonly #messages: string[] = [];
    readonly #pending: PendingMessage[] = [];
    readonly #socket: AgentDaemonSocket;
    readonly #sourceSequences = new Map<string, number>();

    private constructor(socket: AgentDaemonSocket) {
        this.#socket = socket;
        this.#closed = new Promise((resolve) => {
            if (socket.readyState === 3) {
                resolve();
                return;
            }
            socket.addEventListener("close", () => resolve(), { once: true });
        });
        socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
                return;
            }
            const kind = decodeMessageKind(event.data);
            const pendingIndex = this.#pending.findIndex(
                (candidate) => candidate.kind === kind || candidate.kind === "*",
            );
            const pending = pendingIndex < 0 ? undefined : this.#pending.splice(pendingIndex, 1)[0];
            if (pending === undefined) {
                this.#messages.push(event.data);
                return;
            }
            pending.resolve(event.data);
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
            const error = (): void => {
                cleanup();
                reject(new Error("The fake Agent-daemon WebSocket failed while opening"));
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
        return new FakeAgentDaemon(socket);
    }

    readonly available = (kind: string): number =>
        this.#messages.filter((message) => decodeMessageKind(message) === kind).length;

    readonly close = (): void => this.#socket.close(1000, "Fake Agent-daemon complete");

    readonly waitForClose = async (signal: AbortSignal): Promise<void> => await waitFor(this.#closed, signal);

    readonly receive = (kind: string, cancellation?: AbortSignal): Promise<string> => {
        cancellation?.throwIfAborted();
        const existingIndex = this.#messages.findIndex((message) => decodeMessageKind(message) === kind);
        if (existingIndex >= 0) {
            const message = this.#messages.splice(existingIndex, 1)[0];
            return message === undefined
                ? Promise.reject(new Error(`Missing queued ${kind} message`))
                : Promise.resolve(message);
        }
        return new Promise((resolve, reject) => {
            const deadline = AbortSignal.timeout(20_000);
            const signal = cancellation === undefined ? deadline : AbortSignal.any([cancellation, deadline]);
            const pending: PendingMessage = {
                kind,
                reject: (error) => {
                    signal.removeEventListener("abort", abort);
                    reject(error);
                },
                resolve: (message) => {
                    signal.removeEventListener("abort", abort);
                    resolve(message);
                },
            };
            const abort = (): void => {
                const index = this.#pending.indexOf(pending);
                if (index >= 0) {
                    this.#pending.splice(index, 1);
                }
                reject(cancellation?.aborted ? cancellation.reason : new Error(`Fake Agent-daemon missed ${kind}`));
            };
            this.#pending.push(pending);
            signal.addEventListener("abort", abort, { once: true });
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
                kind: "*",
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

    readonly sendSessionEvent = async (sessionId: string, payload: string, signal?: AbortSignal): Promise<string> => {
        signal?.throwIfAborted();
        const eventId = crypto.randomUUID();
        if (decodeMessageKind(payload) === SESSION_STARTED_KIND) {
            const started = decodeSessionStartedEvent(payload);
            this.#attemptIdsByCommand.set(`${sessionId}:${started.commandId}`, started.attemptId);
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
            commandId === undefined ? undefined : this.#attemptIdsByCommand.get(`${sessionId}:${commandId}`);
        const sourceKey = attemptId === undefined ? `runtime:${sessionId}` : `attempt:${sessionId}:${attemptId}`;
        const sourceSequence = (this.#sourceSequences.get(sourceKey) ?? 0) + 1;
        this.#sourceSequences.set(sourceKey, sourceSequence);
        this.#socket.send(
            encodeSessionEventEnvelope({
                eventId,
                kind: SESSION_EVENT_KIND,
                payload,
                sessionId,
                source:
                    attemptId === undefined
                        ? { kind: "runtime", sourceSeq: sourceSequence.toString() }
                        : { attemptId, kind: "attempt", sourceSeq: sourceSequence.toString() },
            }),
        );
        const acknowledgement = decodeSessionEventAcknowledgement(await this.receive(SESSION_EVENT_ACK_KIND, signal));
        if (
            acknowledgement.eventId !== eventId ||
            acknowledgement.sessionId !== sessionId ||
            acknowledgement.duplicate
        ) {
            throw new Error("The server returned an invalid Session event acknowledgement");
        }
        return acknowledgement.sequence;
    };

    async [Symbol.asyncDispose](): Promise<void> {
        this.close();
        await this.#closed;
    }
}

const imagePath = "/fake/generated-image.png";
const imageBytes = Uint8Array.from(
    Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
    ),
);

export interface FakeAgentDaemonBehavior {
    readonly agentName?: string;
    readonly directoryLabel?: string;
}

export interface RunningFakeAgentDaemon extends AsyncDisposable {
    /** Rejects when the fake cannot continue serving the protocol. */
    readonly failure: Promise<never>;
}

async function processHappyPathCommand(
    daemon: FakeAgentDaemon,
    encoded: string,
    behavior: FakeAgentDaemonBehavior,
    turn: number,
    signal: AbortSignal,
): Promise<number> {
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
        return await processHappyPathCommand(daemon, delivery.payload, behavior, turn, signal);
    }
    if (kind === RUNTIME_HEARTBEAT_KIND) {
        const heartbeat = decodeRuntimeHeartbeatEvent(encoded);
        daemon.send(
            encodeRuntimeHeartbeatAckEvent({
                heartbeatId: heartbeat.heartbeatId,
                kind: "runtime.heartbeat.ack",
            }),
        );
        return turn;
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
        return turn;
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
            return turn;
        }
        await daemon.sendSessionEvent(command.sessionId, encodeSessionReadyEvent(ready), signal);
        return turn;
    }
    if (kind === FILE_READ_KIND) {
        const command = decodeFileReadCommand(encoded);
        daemon.send(
            encodeFileBeginEvent({
                byteLength: imageBytes.byteLength,
                kind: "file.begin",
                mediaType: "image/png",
                modifiedAt: "2026-01-01T00:00:00.000Z",
                name: "generated-image.png",
                requestId: command.requestId,
                sessionId: command.sessionId,
            }),
        );
        daemon.send(
            encodeFileChunkEvent({
                data: Buffer.from(imageBytes).toString("base64"),
                kind: "file.chunk",
                requestId: command.requestId,
                sequence: 0,
                sessionId: command.sessionId,
            }),
        );
        daemon.send(
            encodeFileEndEvent({
                kind: "file.end",
                requestId: command.requestId,
                sessionId: command.sessionId,
            }),
        );
        return turn;
    }
    if (kind !== SESSION_PROMPT_KIND) {
        return turn;
    }
    const command = decodeSessionPromptCommand(encoded);
    const nextTurn = turn + 1;
    await daemon.sendSessionEvent(
        command.sessionId,
        encodeSessionStartedEvent({
            attemptId: `fake-attempt-${nextTurn.toString()}`,
            commandId: command.commandId,
            kind: SESSION_STARTED_KIND,
            sessionId: command.sessionId,
        }),
        signal,
    );
    if (command.prompt.toLowerCase().includes("image")) {
        const content = {
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
        };
        await daemon.sendSessionEvent(
            command.sessionId,
            encodeAgentActivityEvent({
                activityId: `fake-image-${nextTurn.toString()}`,
                activityType: "tool",
                commandId: command.commandId,
                content: [content],
                detail: { content: [content], input: command.prompt, kind: "recorded", output: imagePath },
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
            messageId: `fake-message-${nextTurn.toString()}`,
            sessionId: command.sessionId,
            text: `${behavior.agentName ?? "Fake Agent"} turn ${nextTurn.toString()}: ${command.prompt}`,
        }),
        signal,
    );
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
    return nextTurn;
}

export function serveFakeAgentDaemon(
    daemon: FakeAgentDaemon,
    behavior: FakeAgentDaemonBehavior = {},
): RunningFakeAgentDaemon {
    const cancellation = new AbortController();
    const failure = Promise.withResolvers<never>();
    const running = (async () => {
        let turn = 0;
        while (!cancellation.signal.aborted) {
            const message = await daemon.receiveAny(cancellation.signal);
            turn = await processHappyPathCommand(daemon, message, behavior, turn, cancellation.signal);
        }
    })();
    void running.catch((error: unknown) => {
        if (!cancellation.signal.aborted) {
            failure.reject(error);
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
        },
    };
}
