import { harnessAdapters } from "../acp/adapter/registry.ts";
import type { AdapterResolver } from "../acp/native-history/preview-contract.ts";
import type { CatalogAgent } from "./catalog.ts";

/** Local Agent inventory and its explicitly registered harness adapters. */
export class RuntimeAgentDependencies {
    readonly agents: readonly CatalogAgent[];
    readonly adapters: AdapterResolver;

    constructor(agents: readonly CatalogAgent[], adapters: AdapterResolver = harnessAdapters) {
        this.agents = agents;
        this.adapters = adapters;
    }
}
