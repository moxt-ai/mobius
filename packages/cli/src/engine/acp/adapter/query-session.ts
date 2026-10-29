import { methods } from "@agentclientprotocol/sdk";
import type { SessionCapabilities } from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../acp-error.ts";
import type { NativeSessionQuery, SessionEventPage, SessionEventStore } from "../native-history/preview-contract.ts";
import { type NativeSessionPage, nativeSessionPageSchema } from "../protocol/native-session.ts";
import { RetryableAcpInitializationError, validateAgentRuntime } from "./agent-initialization.ts";
import type { AcpSessionConnector, AdapterSessionConnection } from "./session-events.ts";

/** Adapter-owned ACP reader. It has neither a live observer nor interactive-session state. */
export class AcpQuerySession {
    readonly #options: NativeSessionQuery;
    readonly #events: SessionEventStore;
    readonly #connection: AdapterSessionConnection;
    #lifecycle: { readonly kind: "open" } | { readonly kind: "terminated" } = { kind: "open" };
    #eventScope: string = crypto.randomUUID();

    private constructor(options: NativeSessionQuery, events: SessionEventStore, connector: AcpSessionConnector) {
        this.#options = options;
        this.#events = events;
        this.#connection = connector.connectQuerySession({
            agent: options.agent,
            cwd: options.cwd,
            ...(options.externalizeUpdate === undefined ? {} : { externalizeUpdate: options.externalizeUpdate }),
            onEvent: async (event) => {
                this.#events.append(this.#eventScope, { type: "acp", payload: event.payload });
            },
        });
        void this.#connection.termination.then(() => {
            this.#lifecycle = { kind: "terminated" };
        });
    }

    static readonly start = async (
        options: NativeSessionQuery,
        events: SessionEventStore,
        connector: AcpSessionConnector,
    ): Promise<AcpQuerySession> => {
        const { agent, signal } = options;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await validateAgentRuntime(agent, signal);
            const runtime = new AcpQuerySession(options, events, connector);
            try {
                await runtime.#connection.initializeAgent(options.signal);
                return runtime;
            } catch (error) {
                await runtime.closeProcess();
                signal.throwIfAborted();
                if (error instanceof RetryableAcpInitializationError && attempt === 1) {
                    console.warn(`[${agent.id}-acp] ACP agent initialization failed; retrying once`);
                    continue;
                }
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent initialization failed", { cause: error });
            }
        }
        throw new AcpExecutionError("ACP agent initialization failed");
    };

    readonly capabilities = (): SessionCapabilities => this.#connection.snapshot().capabilities;
    readonly hasTerminated = (): boolean => {
        switch (this.#lifecycle.kind) {
            case "open":
                return false;
            case "terminated":
                return true;
            default: {
                const unreachable: never = this.#lifecycle;
                return unreachable;
            }
        }
    };
    readonly listNativeSessions = async (cursor: string | null, signal: AbortSignal): Promise<NativeSessionPage> => {
        if (!this.capabilities().listSessions) {
            throw new AcpExecutionError(
                "This Agent does not support native session listing",
                {},
                "native_session_unsupported",
            );
        }
        const response: unknown = await this.#connection.race(
            this.#connection.connection.agent.request(methods.agent.session.list, cursor === null ? {} : { cursor }, {
                cancellationSignal: signal,
            }),
            "ACP agent exited while listing sessions",
            signal,
        );
        const decoded = nativeSessionPageSchema.safeParse(response);
        if (!decoded.success) {
            throw new AcpExecutionError(
                "The Agent returned an invalid native session list",
                { cause: decoded.error },
                "invalid_native_session_response",
            );
        }
        return decoded.data;
    };

    readonly previewEvents = async (
        nativeSessionId: string,
        eventLimit: number,
        signal: AbortSignal,
    ): Promise<SessionEventPage> => {
        if (!this.capabilities().loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        this.#eventScope = nativeSessionId;
        this.#events.reset(nativeSessionId);
        this.#connection.events.select(nativeSessionId);
        this.#connection.beginStateChange();
        const response: unknown = await this.#connection.race(
            this.#connection.connection.agent.request(
                methods.agent.session.load,
                {
                    additionalDirectories: [...this.#options.additionalDirectories],
                    cwd: this.#options.cwd,
                    mcpServers: [],
                    sessionId: nativeSessionId,
                },
                { cancellationSignal: signal },
            ),
            "ACP agent exited while loading history",
            signal,
        );
        await this.#connection.events.drained();
        signal.throwIfAborted();
        this.#connection.commitLifecycle(response);
        return this.#events.page(nativeSessionId, eventLimit, null);
    };

    readonly closeProcess = async (): Promise<void> => await this.#connection.closeProcess();
    readonly discardEvents = (): void => this.#events.remove(this.#eventScope);
}
