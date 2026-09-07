import { readGrantedAgents } from "../agent-installation/installation-grants.ts";
import { readStateDirectory } from "../storage/state-directory.ts";
import { LocalAgentInventory } from "./agent-discovery.ts";
import type { LocalAgentDiscoveryContext } from "./agent-discovery-context.ts";
import type { LocalAgentSpecification } from "./agent-specification.ts";
import { supportedLocalAgentSpecifications } from "./agents/supported-agent-specifications.ts";
import { discoverAgent } from "./discover-agent.ts";

export {
  AvailableAgent,
  LocalAgentInventory,
} from "./agent-discovery.ts";
export type { LocalAgentSpecification } from "./agent-specification.ts";
export { CodexAgentSpecification } from "./agents/codex-agent.ts";
export { DeepSeekHarnessAgentSpecification } from "./agents/deepseek-harness-agent.ts";
export { OpenCodeAgentSpecification } from "./agents/opencode-agent.ts";
export { PiAgentSpecification } from "./agents/pi-agent.ts";
export { supportedLocalAgentSpecifications } from "./agents/supported-agent-specifications.ts";
export { resolveAgentExecutable } from "./executable-discovery.ts";

export interface DiscoverLocalAgentInventoryOptions
  extends LocalAgentDiscoveryContext {
  readonly specifications?: readonly LocalAgentSpecification[];
}

export async function discoverLocalAgentInventory(
  options: DiscoverLocalAgentInventoryOptions,
): Promise<LocalAgentInventory> {
  const specifications =
    options.specifications ?? supportedLocalAgentSpecifications();
  const discoveries = await Promise.all(
    specifications.map(
      async (specification) => await discoverAgent(specification, options),
    ),
  );
  let grantedAgents: ReadonlySet<string> = new Set<string>();
  try {
    grantedAgents = await readGrantedAgents(
      readStateDirectory(options.environment),
    );
  } catch {
    // An invalid local grant is ignored so it can never widen installation authority.
  }
  return new LocalAgentInventory(
    discoveries,
    grantedAgents,
    options.platform,
    options.architecture,
  );
}
