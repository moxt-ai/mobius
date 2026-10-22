import { type AgentApp, type AgentConnection, agent as createAgentApp, methods } from "@agentclientprotocol/sdk";
import type {
    AcpEndpointTermination,
    InProcessAcpEndpoint,
    InProcessAcpEndpointOptions,
} from "../../agent/in-process-endpoint.ts";
import { PiAcpAgent } from "./upstream/dist/acp/agent.js";
import { createPiAcpClient } from "./upstream/dist/acp/client.js";

export class PiAcpEndpoint implements InProcessAcpEndpoint {
    #agent: PiAcpAgent | null = null;
    readonly #app: AgentApp;
    #closePromise: Promise<void> | null = null;
    #connection: AgentConnection | null = null;
    readonly #resolveTermination: (termination: AcpEndpointTermination) => void;
    readonly terminated: Promise<AcpEndpointTermination>;

    constructor(options: InProcessAcpEndpointOptions) {
        const termination = Promise.withResolvers<AcpEndpointTermination>();
        this.terminated = termination.promise;
        this.#resolveTermination = termination.resolve;
        const environment = Object.freeze({
            ...process.env,
            ...options.environment,
            PI_ACP_PI_COMMAND: options.command,
        });
        let piAgent: PiAcpAgent | null = null;
        this.#app = createAgentApp({ name: "mobius-pi" })
            .onConnect((connection) => {
                this.#connection = connection;
                piAgent = new PiAcpAgent(createPiAcpClient(connection), { environment });
                this.#agent = piAgent;
            })
            .onRequest(
                methods.agent.initialize,
                async (context) => await piAgentOrThrow(piAgent).initialize(context.params),
            )
            .onRequest(
                methods.agent.authenticate,
                async (context) => await piAgentOrThrow(piAgent).authenticate(context.params),
            )
            .onRequest(
                methods.agent.session.new,
                async (context) => await piAgentOrThrow(piAgent).newSession(context.params),
            )
            .onRequest(
                methods.agent.session.load,
                async (context) => await piAgentOrThrow(piAgent).loadSession(context.params),
            )
            .onRequest(
                methods.agent.session.list,
                async (context) => await piAgentOrThrow(piAgent).listSessions(context.params),
            )
            .onRequest(
                methods.agent.session.delete,
                async (context) => await piAgentOrThrow(piAgent).deleteSession(context.params),
            )
            .onRequest(
                methods.agent.session.fork,
                async (context) => await piAgentOrThrow(piAgent).forkSession(context.params),
            )
            .onRequest(
                methods.agent.session.setMode,
                async (context) => await piAgentOrThrow(piAgent).setSessionMode(context.params),
            )
            .onRequest(
                methods.agent.session.setConfigOption,
                async (context) => await piAgentOrThrow(piAgent).setSessionConfigOption(context.params),
            )
            .onRequest(methods.agent.session.prompt, async (context) => {
                const agent = piAgentOrThrow(piAgent);
                const cancel = (): void => {
                    void agent.cancel({ sessionId: context.params.sessionId });
                };
                context.signal.addEventListener("abort", cancel, { once: true });
                try {
                    return await agent.prompt(context.params);
                } finally {
                    context.signal.removeEventListener("abort", cancel);
                }
            })
            .onRequest(
                "_session/steering",
                (params: unknown) => params,
                async (context) => await piAgentOrThrow(piAgent).steer(context.params, context.signal),
            )
            .onNotification(methods.agent.session.cancel, async (context) => {
                await piAgentOrThrow(piAgent).cancel(context.params);
            });
    }

    readonly app = (): AgentApp => this.#app;

    readonly initialize = async (signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
    };

    readonly close = (): Promise<void> => {
        if (this.#closePromise === null) {
            this.#closePromise = Promise.resolve().then(() => {
                try {
                    this.#agent?.dispose();
                } finally {
                    this.#connection?.close();
                    this.#resolveTermination({ kind: "closed" });
                }
            });
        }
        return this.#closePromise;
    };
}

function piAgentOrThrow(agent: PiAcpAgent | null): PiAcpAgent {
    if (agent === null) {
        throw new Error("The Pi ACP client is not connected");
    }
    return agent;
}
