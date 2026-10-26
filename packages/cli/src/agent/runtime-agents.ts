import { AdapterRegistry } from "../acp/adapter/adapter-registry.ts";
import { harnessAdapters } from "../acp/adapter/registry.ts";
import { AcpContentExternalizer } from "../acp/content/content-externalizer.ts";
import type { AdapterDependencies, AdapterResolver } from "../acp/native-history/preview-contract.ts";
import type { CatalogAgent } from "./catalog.ts";

export function createRuntimeAdapterRegistry(
    adapters: AdapterResolver,
    processes: AdapterDependencies["processes"],
    externalize: ConstructorParameters<typeof AcpContentExternalizer>[0],
): AdapterRegistry {
    return new AdapterRegistry(adapters, {
        processes,
        contentExternalizer: new AcpContentExternalizer(externalize),
    });
}

/** Local Agent inventory and its explicitly registered harness adapters. */
export class RuntimeAgentDependencies {
    readonly agents: readonly CatalogAgent[];
    readonly adapters: AdapterResolver;

    constructor(agents: readonly CatalogAgent[], adapters: AdapterResolver = harnessAdapters) {
        this.agents = agents;
        this.adapters = adapters;
    }
}
