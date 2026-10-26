import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import type { Adapter, AdapterDependencies, AdapterResolver } from "../native-history/preview-contract.ts";

/** Stable harness adapters for one runtime; query behavior belongs to each adapter. */
export class AdapterRegistry {
    readonly #resolve: AdapterResolver;
    readonly #dependencies: AdapterDependencies;
    readonly #adapters = new Map<string, Adapter>();

    constructor(resolve: AdapterResolver, dependencies: AdapterDependencies) {
        this.#resolve = resolve;
        this.#dependencies = dependencies;
    }

    readonly resolve = (agent: AcpAgentDefinition): Adapter => {
        const existing = this.#adapters.get(agent.id);
        if (existing !== undefined) {
            return existing;
        }
        const adapter = this.#resolve(agent, this.#dependencies);
        this.#adapters.set(agent.id, adapter);
        return adapter;
    };

    readonly close = async (): Promise<void> => {
        await Promise.all([...this.#adapters.values()].map((adapter) => adapter.close()));
        this.#adapters.clear();
    };
}
