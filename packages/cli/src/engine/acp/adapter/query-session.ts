import { methods } from "@agentclientprotocol/sdk";
import type { SessionCapabilities, SessionConfigOption } from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../acp-error.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import type { SessionEventPage, SessionEventStore } from "../native-history/preview-contract.ts";
import { type NativeSessionPage, nativeSessionPageSchema } from "../protocol/native-session.ts";
import { unsupportedSessionCapabilities } from "../protocol/session-capabilities.ts";
import {
    initializeAgentConnection,
    RetryableAcpInitializationError,
    validateAgentRuntime,
} from "./agent-initialization.ts";
import type { AcpSessionConnector, AdapterSessionConnection } from "./session-events.ts";

/** Adapter-owned ACP reader. It has neither a live observer nor interactive-session state. */
export class AcpQuerySession {
    readonly #cwd: string;
    readonly #sessionId: string;
    readonly #events: SessionEventStore;
    readonly #connection: AdapterSessionConnection;
    #lifecycle: { readonly kind: "open" } | { readonly kind: "terminated" } = { kind: "open" };
    #capabilities: SessionCapabilities = unsupportedSessionCapabilities();
    #configOptions: readonly SessionConfigOption[] = [];

    private constructor(
        agent: AcpAgentDefinition,
        cwd: string,
        sessionId: string,
        events: SessionEventStore,
        connector: AcpSessionConnector,
    ) {
        this.#cwd = cwd;
        this.#sessionId = sessionId;
        this.#events = events;
        this.#connection = connector.connectQuerySession({
            agent,
            cwd,
            sessionId: () => sessionId,
            configOptions: () => this.#configOptions,
            onEvent: async (event) => {
                this.#events.append(sessionId, { type: "acp", payload: event.payload });
                if (event.kind === "configuration") {
                    this.#configOptions = event.configOptions;
                }
            },
        });
        void this.#connection.termination.then(() => {
            this.#lifecycle = { kind: "terminated" };
        });
    }

    static readonly start = async (
        agent: AcpAgentDefinition,
        cwd: string,
        sessionId: string,
        events: SessionEventStore,
        connector: AcpSessionConnector,
        signal: AbortSignal,
    ): Promise<AcpQuerySession> => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await validateAgentRuntime(agent, signal);
            const runtime = new AcpQuerySession(agent, cwd, sessionId, events, connector);
            try {
                const initialized = await initializeAgentConnection(
                    runtime.#connection,
                    agent.id,
                    agent.agentVersion,
                    signal,
                );
                runtime.#capabilities = initialized.capabilities;
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

    readonly capabilities = (): SessionCapabilities => this.#capabilities;
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
        if (!this.#capabilities.listSessions) {
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
        additionalDirectories: readonly string[],
        signal: AbortSignal,
    ): Promise<SessionEventPage> => {
        if (!this.#capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        this.#events.reset(this.#sessionId);
        this.#connection.events.select(nativeSessionId);
        await this.#connection.race(
            this.#connection.connection.agent.request(
                methods.agent.session.load,
                {
                    additionalDirectories: [...additionalDirectories],
                    cwd: this.#cwd,
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
        return this.#events.page(this.#sessionId, eventLimit, null);
    };

    readonly closeProcess = async (): Promise<void> => await this.#connection.closeProcess();
    readonly discardEvents = (): void => this.#events.remove(this.#sessionId);
}
