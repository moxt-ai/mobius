import type { AgentApp, AgentConnection } from "@agentclientprotocol/sdk";
import type {
    AcpEndpointTermination,
    InProcessAcpEndpoint,
    InProcessAcpEndpointOptions,
} from "../../agent/in-process-endpoint.ts";
import { createClaudeAcpApp } from "./upstream/dist/lib.js";

export class ClaudeAcpEndpoint implements InProcessAcpEndpoint {
    readonly #agent;
    readonly #app: AgentApp;
    #closePromise: Promise<void> | null = null;
    #connection: AgentConnection | null = null;
    readonly #resolveTermination: (termination: AcpEndpointTermination) => void;
    readonly terminated: Promise<AcpEndpointTermination>;

    constructor(options: InProcessAcpEndpointOptions) {
        const termination = Promise.withResolvers<AcpEndpointTermination>();
        this.terminated = termination.promise;
        this.#resolveTermination = termination.resolve;
        const claude = createClaudeAcpApp({
            environment: Object.freeze({
                ...process.env,
                ...options.environment,
                CLAUDE_CODE_EXECUTABLE: options.command,
            }),
            onConnect: (connection) => {
                this.#connection = connection;
            },
        });
        this.#agent = claude.agent;
        this.#app = claude.app;
    }

    readonly app = (): AgentApp => this.#app;

    readonly initialize = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
    };

    readonly close = (): Promise<void> => {
        if (this.#closePromise === null) {
            this.#closePromise = (async () => {
                try {
                    await this.#agent()?.dispose();
                } finally {
                    this.#connection?.close();
                    this.#resolveTermination({ kind: "closed" });
                }
            })();
        }
        return this.#closePromise;
    };
}
