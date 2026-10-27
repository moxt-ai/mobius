import type { ClientConnection } from "@agentclientprotocol/sdk";
import type { InProcessAcpEndpoint } from "../agent/in-process-endpoint.ts";
import type { AgentConnection } from "./agent-connection.ts";
import { raceAgentOperation } from "./agent-operation.ts";
import { type AcpClientHandler, createAcpClient } from "./create-client.ts";

/** Shared local ACP transport mechanics; the adapter constructs and wires its endpoint. */
export abstract class EndpointAgentConnection implements AgentConnection {
    readonly #endpoint: InProcessAcpEndpoint;
    readonly connection: ClientConnection;
    readonly termination;
    #closePromise: Promise<void> | null = null;

    constructor(endpoint: InProcessAcpEndpoint, client: AcpClientHandler) {
        this.#endpoint = endpoint;
        this.termination = endpoint.terminated;
        this.connection = createAcpClient(client).connect(endpoint.app());
    }

    readonly initialize = async (signal: AbortSignal): Promise<void> => {
        await this.#endpoint.initialize(signal);
    };

    readonly agentSettingsModelEffort = () => this.#endpoint.agentSettingsModelEffort?.() ?? null;

    readonly closeProcess = (): Promise<void> => {
        this.#closePromise ??= (async () => {
            try {
                await this.#endpoint.close();
            } finally {
                this.connection.close();
            }
        })();
        return this.#closePromise;
    };

    readonly race = <T>(operation: Promise<T>, exitMessage: string, signal: AbortSignal): Promise<T> =>
        raceAgentOperation(operation, this.termination, exitMessage, signal);
}
