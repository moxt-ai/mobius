import { decodeMessageKind, encodeSessionEventEnvelope, SESSION_EVENT_KIND } from "@moxt-ai/mobius-protocol";
import { FakeAgentDaemonState } from "./state.ts";

export { FakeAgentDaemonState };

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

/** A stateful peer at the public daemon/server protocol boundary. */
export class FakeAgentDaemon implements AsyncDisposable {
    readonly #state: FakeAgentDaemonState;
    readonly #closed: Promise<void>;
    #closeCode = 1006;
    #closeReason = "Connection closed unexpectedly";
    readonly #messages: string[] = [];
    readonly #pending: PendingMessage[] = [];
    readonly #socket: AgentDaemonSocket;

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
            if (this.#state.reply(message, (reply) => this.#socket.send(reply))) {
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
        state = new FakeAgentDaemonState(),
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

    readonly receive = (
        kind: string,
        cancellation: AbortSignal = AbortSignal.timeout(8_000),
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
                reject(new Error(`Waiting for daemon command ${kind}`, { cause: cancellation.reason }));
            };
            this.#pending.push(pending);
            cancellation?.addEventListener("abort", abort, { once: true });
            if (cancellation?.aborted === true) {
                abort();
            }
        });
    };

    readonly send = (message: string): void => {
        this.#state.observe(message);
        this.#socket.send(message);
    };

    readonly sendSessionEvent = async (sessionId: string, payload: string, signal?: AbortSignal): Promise<void> => {
        signal?.throwIfAborted();
        this.#state.record(sessionId, payload);
        this.#socket.send(encodeSessionEventEnvelope({ kind: SESSION_EVENT_KIND, payload, sessionId }));
    };
    async [Symbol.asyncDispose](): Promise<void> {
        this.close();
        await this.#closed;
    }
}
