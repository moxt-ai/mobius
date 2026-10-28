import type { LocalAgentSpecification } from "../specification/agent-specification.ts";
import { supportedLocalAgentSpecifications } from "../specification/vendors/supported-agent-specifications.ts";
import { AgentDiscoveryResult, LocalAgentInventory } from "./agent-discovery.ts";
import type { LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import { discoverAgent } from "./discover-agent.ts";

export { CodexAgentSpecification } from "../specification/vendors/codex-agent.ts";
export { PiAgentSpecification } from "../specification/vendors/pi-agent.ts";
export { supportedLocalAgentSpecifications } from "../specification/vendors/supported-agent-specifications.ts";
export {
    AvailableAgent,
    LocalAgentInventory,
} from "./agent-discovery.ts";
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

export { staticLocalAgentInventory } from "./agent-discovery.ts";
