import { methods } from "@agentclientprotocol/sdk";
import type { SessionCapabilities, SessionConfigOption } from "@moxt-ai/mobius-sdk/protocol";
import { arraysEqual } from "../../util/value-utils.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { NativeSessionQuery, SessionEventPage, SessionEventStore } from "../native-history/preview-contract.ts";
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
    readonly #options: NativeSessionQuery;
    readonly #events: SessionEventStore;
    readonly #connection: AdapterSessionConnection;
    #capabilities: SessionCapabilities = unsupportedSessionCapabilities();
    #configOptions: readonly SessionConfigOption[] = [];

    private constructor(options: NativeSessionQuery, events: SessionEventStore, connector: AcpSessionConnector) {
        this.#options = options;
        this.#events = events;
        this.#connection = connector.connectQuerySession({
            agent: options.agent,
            cwd: options.cwd,
            sessionId: () => options.sessionId,
            configOptions: () => this.#configOptions,
            onEvent: async (event) => {
                this.#events.append(options.sessionId, { type: "acp", payload: event.payload });
                if (event.kind === "configuration") {
                    this.#configOptions = event.configOptions;
                }
            },
        });
    }

    static readonly start = async (
        options: NativeSessionQuery,
        events: SessionEventStore,
        connector: AcpSessionConnector,
    ): Promise<AcpQuerySession> => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await validateAgentRuntime(options.agent, options.signal);
            const runtime = new AcpQuerySession(options, events, connector);
            try {
                const initialized = await initializeAgentConnection(
                    runtime.#connection,
                    options.agent.id,
                    options.agent.agentVersion,
                    options.signal,
                );
                runtime.#capabilities = initialized.capabilities;
                return runtime;
            } catch (error) {
                await runtime.closeProcess();
                options.signal.throwIfAborted();
                if (error instanceof RetryableAcpInitializationError && attempt === 1) {
                    console.warn(`[${options.agent.id}-acp] ACP agent initialization failed; retrying once`);
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
    readonly belongsTo = (agentId: string, cwd: string, directories: readonly string[]): boolean =>
        this.#options.agent.id === agentId &&
        this.#options.cwd === cwd &&
        arraysEqual(this.#options.additionalDirectories, directories);

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
        signal: AbortSignal,
    ): Promise<SessionEventPage> => {
        if (!this.#capabilities.loadSession) {
            throw new AcpExecutionError(
                "This Agent restores context but does not provide message history.",
                {},
                "native_history_unsupported",
            );
        }
        this.#events.reset(this.#options.sessionId);
        this.#connection.events.select(nativeSessionId);
        await this.#connection.race(
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
        return this.#events.page(this.#options.sessionId, eventLimit, null);
    };

    readonly closeProcess = async (): Promise<void> => await this.#connection.closeProcess();
}
