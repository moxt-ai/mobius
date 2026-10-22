import {
    type AgentApp,
    type AgentConnection,
    agent as createAgentApp,
    methods,
    PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

import type {
    AcpEndpointTermination,
    InProcessAcpEndpoint,
    InProcessAcpEndpointFactory,
} from "../../../src/acp/in-process/acp-endpoint.ts";

export interface AgentOperation {
    readonly endpoint: number;
    readonly method: string;
    readonly sessionId: string;
}

/** Keeps the requests that reach it in flight until a scenario releases them. */
export class RequestGate {
    #held: Promise<void> = Promise.resolve();
    #entered = Promise.withResolvers<void>();
    #release: () => void = () => undefined;

    /** Blocks the requests that arrive from now on; `entered` settles once one of them is waiting. */
    readonly hold = (): { readonly entered: Promise<void>; readonly release: () => void } => {
        const held = Promise.withResolvers<void>();
        this.#entered = Promise.withResolvers<void>();
        this.#held = held.promise;
        this.#release = held.resolve;
        return { entered: this.#entered.promise, release: held.resolve };
    };

    readonly release = (): void => this.#release();

    readonly pass = async (): Promise<void> => {
        this.#entered.resolve();
        await this.#held;
    };
}

function renameRequest(params: unknown): { readonly sessionId: string } {
    if (
        typeof params === "object" &&
        params !== null &&
        "sessionId" in params &&
        typeof params.sessionId === "string"
    ) {
        return { sessionId: params.sessionId };
    }
    throw new Error("Invalid controlled Agent rename request");
}

/** One Agent process; records the Session requests it serves. */
export class ControlledSessionEndpoint implements InProcessAcpEndpoint {
    readonly #agent: ControlledSessionAgent;
    readonly #app: AgentApp;
    #connection: AgentConnection | null = null;
    readonly #termination = Promise.withResolvers<AcpEndpointTermination>();
    readonly terminated = this.#termination.promise;

    constructor(endpoint: number, agent: ControlledSessionAgent) {
        this.#agent = agent;
        const record = (method: string, sessionId: string): void => {
            agent.operations.push({ endpoint, method, sessionId });
        };
        this.#app = createAgentApp({ name: "controlled-session-agent" })
            .onConnect((connection) => {
                this.#connection = connection;
            })
            .onRequest(methods.agent.initialize, () => ({
                _meta: { renameSession: { supported: true } },
                agentCapabilities: {
                    loadSession: false,
                    promptCapabilities: { embeddedContext: false, image: false },
                    sessionCapabilities: { close: {}, resume: {} },
                },
                agentInfo: { name: "Controlled Session Agent", version: "1.0.0" },
                authMethods: [],
                protocolVersion: PROTOCOL_VERSION,
            }))
            .onRequest(methods.agent.session.new, () => {
                const sessionId = crypto.randomUUID();
                record(methods.agent.session.new, sessionId);
                return { sessionId };
            })
            .onRequest(methods.agent.session.resume, (context) => {
                record(methods.agent.session.resume, context.params.sessionId);
                return {};
            })
            .onRequest(methods.agent.session.prompt, async (context) => {
                record(methods.agent.session.prompt, context.params.sessionId);
                await agent.turns.pass();
                return { stopReason: "end_turn" as const };
            })
            .onRequest("_session/rename", renameRequest, async (context) => {
                record("_session/rename", context.params.sessionId);
                await agent.renames.pass();
                return {};
            })
            .onRequest(methods.agent.session.close, (context) => {
                record(methods.agent.session.close, context.params.sessionId);
                return {};
            });
    }

    readonly app = (): AgentApp => this.#app;
    readonly initialize = async (signal: AbortSignal): Promise<void> => signal.throwIfAborted();
    readonly close = async (): Promise<void> => {
        await this.#agent.closes.pass();
        this.#connection?.close();
        this.#termination.resolve({ kind: "closed" });
    };

    readonly reportTitle = async (sessionId: string, title: string): Promise<void> => {
        if (this.#connection === null) {
            throw new Error("The Agent endpoint is not connected");
        }
        await this.#connection.client.notify(methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "session_info_update", title },
        });
    };
}

/**
 * A controlled in-process Agent. Every Agent process the Runtime starts for it takes the next
 * endpoint index, so a scenario can tell which process served each request.
 */
export class ControlledSessionAgent {
    readonly operations: AgentOperation[] = [];
    /** Holds `session/prompt`, so a turn stays running. */
    readonly turns = new RequestGate();
    /** Holds `_session/rename`. */
    readonly renames = new RequestGate();
    /** Holds the end of process teardown, so a close stays in flight. */
    readonly closes = new RequestGate();
    readonly #endpoints: ControlledSessionEndpoint[] = [];

    readonly createEndpoint: InProcessAcpEndpointFactory = () => {
        const endpoint = new ControlledSessionEndpoint(this.#endpoints.length, this);
        this.#endpoints.push(endpoint);
        return endpoint;
    };

    readonly endpointCount = (): number => this.#endpoints.length;

    readonly endpoint = (index: number): ControlledSessionEndpoint => {
        const endpoint = this.#endpoints[index];
        if (endpoint === undefined) {
            throw new Error(`Agent endpoint ${index.toString()} was never started`);
        }
        return endpoint;
    };

    readonly releaseAll = (): void => {
        this.turns.release();
        this.renames.release();
        this.closes.release();
    };
}
