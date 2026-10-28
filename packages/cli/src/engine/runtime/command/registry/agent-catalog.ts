import { AGENT_CATALOG_DISCOVER_KIND } from "@moxt-ai/mobius-sdk/protocol";
import { createAgentCatalogDiscoveryHandler } from "../../catalog/handle-agent-catalog-discovery.ts";
import type { CommandContext } from "../context.ts";
import type { RuntimeCommand } from "../definition.ts";

export function createAgentCatalogCommands(context: CommandContext): readonly RuntimeCommand[] {
    const handler = createAgentCatalogDiscoveryHandler({
        config: context.config,
        discover:
            context.config.rediscoverAgents === undefined
                ? () => {
                      throw new Error("Agent catalog discovery is not available for this Runtime");
                  }
                : context.config.rediscoverAgents,
        diagnostics: context.diagnostics,
        socket: context.socket,
        signal: context.signal,
        timer: context.timer,
    });
    return [
        {
            kind: AGENT_CATALOG_DISCOVER_KIND,
            handle: (_context, message): void => {
                if (message.kind !== AGENT_CATALOG_DISCOVER_KIND) {
                    throw new Error("Command kind mismatch");
                }
                handler.handle(message);
            },
            settle: handler.settle,
        },
    ];
}
