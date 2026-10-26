import type { AcpAgentDefinition } from "../acp/agent/agent-definition.ts";
import { OperationError } from "../infra/operation-error.ts";
import { SerialTaskQueue } from "../util/serial-task-queue.ts";

/** The launch definition of a cataloged Agent, as the runtime names it. */
export type CatalogAgent = AcpAgentDefinition;

export class LocalAgentCatalogSnapshot {
    readonly agents: readonly AcpAgentDefinition[];

    constructor(agents: readonly AcpAgentDefinition[]) {
        this.agents = Object.freeze([...agents]);
    }
}

export class LocalAgentCatalogError extends OperationError {
    constructor() {
        super("agent_not_ready", "The requested local Agent is not ready");
        this.name = "LocalAgentCatalogError";
    }
}

export class LocalAgentCatalog {
    #snapshot: LocalAgentCatalogSnapshot;
    readonly #updates = new SerialTaskQueue();

    constructor(agents: readonly AcpAgentDefinition[]) {
        this.#snapshot = this.validate(agents);
    }

    readonly find = (agentId: string): AcpAgentDefinition => {
        for (const agent of this.#snapshot.agents) {
            if (agent.id === agentId) {
                return agent;
            }
        }
        throw new LocalAgentCatalogError();
    };

    readonly read = (): LocalAgentCatalogSnapshot => this.#snapshot;

    /** Serializes replacements and publication; a failed publication restores only its own prior snapshot. */
    readonly replaceAndPublish = async (
        build: (current: readonly CatalogAgent[]) => readonly CatalogAgent[],
        publish: (signal: AbortSignal) => Promise<void>,
        signal: AbortSignal,
    ): Promise<LocalAgentCatalogSnapshot> => {
        return await this.#updates.run(async (updateSignal) => {
            const previous = this.#snapshot;
            const next = this.validate(build(previous.agents));
            this.#snapshot = next;
            try {
                await publish(updateSignal);
            } catch (error) {
                this.#snapshot = previous;
                throw error;
            }
            // Return this publication's snapshot, not a later writer's catalog.
            return next;
        }, signal);
    };

    private readonly validate = (agents: readonly AcpAgentDefinition[]): LocalAgentCatalogSnapshot => {
        const identifiers = new Set<string>();
        for (const agent of agents) {
            if (identifiers.has(agent.id)) {
                throw new Error("The local Agent catalog contains duplicate entries");
            }
            identifiers.add(agent.id);
        }
        return new LocalAgentCatalogSnapshot(agents);
    };
}
