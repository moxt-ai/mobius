import { AGENT_SETTINGS_DISCOVER_KIND } from "@moxt-ai/mobius-sdk/protocol";
import { createAgentSettingsDiscoveryHandler } from "../agent-settings-discovery.ts";
import type { CommandContext } from "../context.ts";
import type { RuntimeCommand } from "../definition.ts";

export function createAgentSettingsCommands(context: CommandContext): readonly RuntimeCommand[] {
    const handler = createAgentSettingsDiscoveryHandler({
        config: context.config,
        directories: context.directories,
        diagnostics: context.diagnostics,
        sessions: context.sessions,
        signal: context.signal,
        transport: context.transport,
        timer: context.timer,
    });
    return [
        {
            kind: AGENT_SETTINGS_DISCOVER_KIND,
            handle: (_context, message): void => {
                if (message.kind !== AGENT_SETTINGS_DISCOVER_KIND) {
                    throw new Error("Command kind mismatch");
                }
                handler.handle(message);
            },
            settle: handler.settle,
        },
    ];
}
