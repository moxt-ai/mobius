import { ClaudeAdapter } from "../../src/engine/acp/adapter/claude/adapter.ts";
import type { AdapterResolver } from "../../src/engine/acp/native-history/preview-contract.ts";

/** Routes every agent through the ACP preview, for agents that have no harness adapter. */
export const acpAdapters: AdapterResolver = (_agent, dependencies) => new ClaudeAdapter(dependencies);
