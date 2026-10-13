import type { SessionHistoryPageRequestV3, SessionHistoryPageV3 } from "@moxt-ai/mobius-protocol";
import type {
    ConnectedNativeSessionV3,
    NativeSessionContextV3,
    NativeSessionPreviewAdapterV3,
    PublishSessionLiveItemV3,
} from "./adapters/adapter-v3.ts";
import { NativeSessionOperationErrorV3 } from "./adapters/adapter-v3.ts";
import type { SessionLiveStateV3 } from "./session-live-state-v3.ts";

export interface NativeAgentLaunchV3 {
    readonly command: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly id: string;
}

export interface NativeSessionAdapterDefinitionV3 {
    readonly agentId: string;
    readonly connect: (
        agent: NativeAgentLaunchV3,
        session: NativeSessionContextV3,
        live: NativeSessionLiveRuntimeV3,
        signal: AbortSignal,
    ) => Promise<ConnectedNativeSessionV3>;
    readonly create: (
        agent: NativeAgentLaunchV3,
        session: Omit<NativeSessionContextV3, "nativeSessionId">,
        live: NativeSessionLiveRuntimeV3,
        signal: AbortSignal,
    ) => Promise<ConnectedNativeSessionV3>;
    readonly openPreview: (
        agent: NativeAgentLaunchV3,
        session: NativeSessionContextV3,
        signal: AbortSignal,
    ) => Promise<NativeSessionAdapterPreviewLeaseV3>;
}

export interface NativeSessionLiveRuntimeV3 {
    readonly publish: PublishSessionLiveItemV3;
    readonly readThroughSeq: () => number;
}

interface ConnectedSessionStateV3 {
    readonly connection: ConnectedNativeSessionV3;
    readonly identity: string;
    readonly live: NativeSessionLiveRuntimeV3;
}

interface PreparingSessionStateV3 {
    readonly completion: Promise<ConnectedNativeSessionV3>;
    readonly identity: string;
}

function sessionIdentity(agent: NativeAgentLaunchV3, session: NativeSessionContextV3): string {
    return JSON.stringify([
        agent.id,
        agent.command,
        session.nativeSessionId,
        session.cwd,
        [...session.additionalDirectories],
    ]);
}

async function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const cancelled = Promise.withResolvers<never>();
    const abort = (): void => cancelled.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
        return await Promise.race([operation, cancelled.promise]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

export interface NativeSessionAdapterPreviewLeaseV3 {
    readonly adapter: NativeSessionPreviewAdapterV3;
    readonly close: (signal: AbortSignal) => Promise<void>;
}

export class NativeSessionRuntimeManagerV3 {
    readonly #connected = new Map<string, ConnectedSessionStateV3>();
    readonly #definitions = new Map<string, NativeSessionAdapterDefinitionV3>();
    readonly #preparing = new Map<string, PreparingSessionStateV3>();
    readonly #shutdown = new AbortController();
    readonly #liveState: SessionLiveStateV3 | null;
    readonly #publishLiveEvent: ((event: ReturnType<SessionLiveStateV3["commit"]>) => void) | null;
    readonly #throughSeq = new Map<string, number>();

    constructor(
        definitions: readonly NativeSessionAdapterDefinitionV3[],
        live?: {
            readonly state: SessionLiveStateV3;
            readonly publish: (event: ReturnType<SessionLiveStateV3["commit"]>) => void;
        },
    ) {
        this.#liveState = live?.state ?? null;
        this.#publishLiveEvent = live?.publish ?? null;
        for (const definition of definitions) {
            if (this.#definitions.has(definition.agentId)) {
                throw new Error(`Duplicate V3 native Session adapter definition: ${definition.agentId}`);
            }
            this.#definitions.set(definition.agentId, definition);
        }
    }

    readonly live = (sessionId: string): NativeSessionLiveRuntimeV3 => {
        if (this.#liveState === null || this.#publishLiveEvent === null) {
            throw new NativeSessionOperationErrorV3(
                "native_session_live_unavailable",
                "The V3 Session live runtime is unavailable",
            );
        }
        return {
            publish: async (item) => {
                const event = this.#liveState?.commit(sessionId, item);
                if (event === undefined) {
                    throw new NativeSessionOperationErrorV3(
                        "native_session_live_unavailable",
                        "The V3 Session live runtime is unavailable",
                    );
                }
                this.#throughSeq.set(sessionId, event.seq);
                this.#publishLiveEvent?.(event);
            },
            readThroughSeq: () => this.#throughSeq.get(sessionId) ?? 0,
        };
    };

    readonly prepare = async (
        agent: NativeAgentLaunchV3,
        session: NativeSessionContextV3,
        live: NativeSessionLiveRuntimeV3,
        signal: AbortSignal,
    ): Promise<ConnectedNativeSessionV3> => {
        const operationSignal = AbortSignal.any([signal, this.#shutdown.signal]);
        operationSignal.throwIfAborted();
        const identity = sessionIdentity(agent, session);
        const connected = this.#connected.get(session.sessionId);
        if (connected?.identity === identity) {
            return connected.connection;
        }
        if (connected !== undefined) {
            this.#connected.delete(session.sessionId);
            await connected.connection.close(AbortSignal.timeout(30_000));
            await connected.live.publish({
                sessionUpdate: "session_lifecycle_changed",
                state: { kind: "disconnected", outcome: { kind: "closed" } },
            });
        }
        const preparing = this.#preparing.get(session.sessionId);
        if (preparing !== undefined) {
            if (preparing.identity !== identity) {
                throw new NativeSessionOperationErrorV3(
                    "session_preparing",
                    "The Session is already preparing a different native identity",
                );
            }
            return await waitForOperation(preparing.completion, operationSignal);
        }
        const definition = this.#definition(agent.id);
        const completion = definition.connect(agent, session, live, operationSignal);
        const state = { completion, identity };
        this.#preparing.set(session.sessionId, state);
        let opened: ConnectedNativeSessionV3 | null = null;
        try {
            const connection = await completion;
            opened = connection;
            operationSignal.throwIfAborted();
            if (connection.nativeSessionId !== session.nativeSessionId) {
                await connection.close(AbortSignal.timeout(30_000));
                opened = null;
                throw new NativeSessionOperationErrorV3(
                    "session_identity_mismatch",
                    "The native Session identity does not match its binding",
                );
            }
            this.#connected.set(session.sessionId, { connection, identity, live });
            opened = null;
            this.#monitor(session.sessionId, connection, live);
            return connection;
        } catch (error) {
            if (opened !== null) {
                await opened.close(AbortSignal.timeout(30_000));
            }
            throw error;
        } finally {
            if (this.#preparing.get(session.sessionId) === state) {
                this.#preparing.delete(session.sessionId);
            }
        }
    };

    readonly create = async (
        agent: NativeAgentLaunchV3,
        session: Omit<NativeSessionContextV3, "nativeSessionId">,
        live: NativeSessionLiveRuntimeV3,
        signal: AbortSignal,
    ): Promise<ConnectedNativeSessionV3> => {
        signal.throwIfAborted();
        const definition = this.#definition(agent.id);
        const connection = await definition.create(agent, session, live, signal);
        const context = { ...session, nativeSessionId: connection.nativeSessionId };
        const identity = sessionIdentity(agent, context);
        this.#connected.set(session.sessionId, { connection, identity, live });
        this.#monitor(session.sessionId, connection, live);
        return connection;
    };

    readonly connected = (sessionId: string): ConnectedNativeSessionV3 => {
        const state = this.#connected.get(sessionId);
        if (state === undefined) {
            throw new NativeSessionOperationErrorV3("session_not_connected", "The Session is not connected");
        }
        return state.connection;
    };

    readonly isConnected = (sessionId: string): boolean => this.#connected.has(sessionId);
    readonly supports = (agentId: string): boolean => this.#definitions.has(agentId);

    readonly closeSession = async (sessionId: string, signal: AbortSignal): Promise<void> => {
        const state = this.#connected.get(sessionId);
        if (state === undefined) {
            return;
        }
        this.#connected.delete(sessionId);
        await state.connection.close(signal);
        await state.live.publish({
            sessionUpdate: "session_lifecycle_changed",
            state: { kind: "disconnected", outcome: { kind: "closed" } },
        });
    };

    readonly close = async (signal: AbortSignal): Promise<void> => {
        this.#shutdown.abort();
        await waitForOperation(
            Promise.allSettled([...this.#preparing.values()].map((state) => state.completion)),
            signal,
        );
        const connected = [...this.#connected.values()];
        this.#connected.clear();
        await Promise.all(connected.map(async (state) => await state.connection.close(signal)));
    };

    readonly previewMessages = async (
        agent: NativeAgentLaunchV3,
        session: NativeSessionContextV3,
        request: SessionHistoryPageRequestV3,
        signal: AbortSignal,
    ): Promise<SessionHistoryPageV3> => {
        const operationSignal = AbortSignal.any([signal, this.#shutdown.signal]);
        operationSignal.throwIfAborted();
        const definition = this.#definition(agent.id);
        const lease = await definition.openPreview(agent, session, operationSignal);
        try {
            return await lease.adapter.previewMessages(session, request, operationSignal);
        } finally {
            await lease.close(AbortSignal.timeout(30_000));
        }
    };

    readonly #definition = (agentId: string): NativeSessionAdapterDefinitionV3 => {
        const definition = this.#definitions.get(agentId);
        if (definition === undefined) {
            throw new NativeSessionOperationErrorV3(
                "native_session_unsupported",
                `V3 native Sessions are not supported for ${agentId}`,
            );
        }
        return definition;
    };

    readonly #monitor = (
        sessionId: string,
        connection: ConnectedNativeSessionV3,
        live: NativeSessionLiveRuntimeV3,
    ): void => {
        void connection
            .waitForTermination(new AbortController().signal)
            .then(async (outcome) => {
                const current = this.#connected.get(sessionId);
                if (current?.connection !== connection) {
                    return;
                }
                this.#connected.delete(sessionId);
                await live.publish({
                    sessionUpdate: "session_lifecycle_changed",
                    state: {
                        kind: "disconnected",
                        outcome:
                            outcome.kind === "closed"
                                ? { kind: "closed" }
                                : { code: outcome.error.code, kind: "failed" },
                    },
                });
                await connection.close(AbortSignal.timeout(30_000));
            })
            .catch((error: unknown) => {
                console.error("The V3 native Session termination monitor failed", error);
            });
    };
}
