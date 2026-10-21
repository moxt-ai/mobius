import { AgentDiscoveryResult, LocalAgentInventory } from "./agent-discovery.ts";
import type { LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import type { LocalAgentSpecification } from "./agent-specification.ts";
import { supportedLocalAgentSpecifications } from "./agents/supported-agent-specifications.ts";
import { discoverAgent } from "./discover-agent.ts";

export {
    AvailableAgent,
    LocalAgentInventory,
} from "./agent-discovery.ts";
export { CodexAgentSpecification } from "./agents/codex-agent.ts";
export { PiAgentSpecification } from "./agents/pi-agent.ts";
export { supportedLocalAgentSpecifications } from "./agents/supported-agent-specifications.ts";
export { resolveAgentExecutable } from "./executable-discovery.ts";

export interface DiscoverLocalAgentInventoryOptions extends LocalAgentDiscoveryContext {
    readonly monotonicTimeMilliseconds?: () => number;
    readonly specifications?: readonly LocalAgentSpecification[];
}

export async function discoverLocalAgentInventory(
    options: DiscoverLocalAgentInventoryOptions,
): Promise<LocalAgentInventory> {
    const specifications = options.specifications ?? supportedLocalAgentSpecifications();
    const monotonicTimeMilliseconds = options.monotonicTimeMilliseconds ?? (() => performance.now());
    const results = await Promise.all(
        specifications.map(async (specification) => {
            const startedAt = monotonicTimeMilliseconds();
            const discovery = await discoverAgent(specification, options);
            return new AgentDiscoveryResult(discovery, monotonicTimeMilliseconds() - startedAt);
        }),
    );
    return new LocalAgentInventory(results);
}
