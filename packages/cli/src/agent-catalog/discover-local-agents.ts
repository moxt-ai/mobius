import { LocalAgentInventory } from "./agent-discovery.ts";
import type { LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import type { LocalAgentSpecification } from "./agent-specification.ts";
import { supportedLocalAgentSpecifications } from "./agents/supported-agent-specifications.ts";
import { discoverAgent } from "./discover-agent.ts";

export {
    AvailableAgent,
    LocalAgentInventory,
} from "./agent-discovery.ts";
export { CodexAgentSpecification } from "./agents/codex-agent.ts";
export { CopilotCliAgentSpecification } from "./agents/copilot-cli-agent.ts";
export { CursorCliAgentSpecification } from "./agents/cursor-cli-agent.ts";
export { DeepSeekHarnessAgentSpecification } from "./agents/deepseek-harness-agent.ts";
export { GrokBuildAgentSpecification } from "./agents/grok-build-agent.ts";
export { OpenCodeAgentSpecification } from "./agents/opencode-agent.ts";
export { PiAgentSpecification } from "./agents/pi-agent.ts";
export { supportedLocalAgentSpecifications } from "./agents/supported-agent-specifications.ts";
export { WorkBuddyAgentSpecification } from "./agents/workbuddy-agent.ts";
export { resolveAgentExecutable } from "./executable-discovery.ts";

export interface DiscoverLocalAgentInventoryOptions extends LocalAgentDiscoveryContext {
    readonly specifications?: readonly LocalAgentSpecification[];
}

export async function discoverLocalAgentInventory(
    options: DiscoverLocalAgentInventoryOptions,
): Promise<LocalAgentInventory> {
    const specifications = options.specifications ?? supportedLocalAgentSpecifications();
    const discoveries = await Promise.all(
        specifications.map(async (specification) => await discoverAgent(specification, options)),
    );
    return new LocalAgentInventory(discoveries);
}
