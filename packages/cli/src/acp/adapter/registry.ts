import type { AcpAgentDefinition } from "../../daemon/config.ts";
import { AcpExecutionError } from "../acp-error.ts";
import { ClaudeAdapter } from "./claude/adapter.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import type { Adapter, AdapterContext, AdapterResolver, NativeSessionPreviewRequest } from "./context.ts";
import { PiAdapter } from "./pi/adapter.ts";

export type { AdapterResolver } from "./context.ts";

/** Previews through ACP `session/load` regardless of the agent. */
class AcpPreviewAdapter implements Adapter {
    readonly previewSessionEvents = async (request: NativeSessionPreviewRequest, context: AdapterContext) =>
        await context.previewThroughAcp(request);
}

/** Routes every agent through the ACP preview; the runtime manager's default. */
export const acpAdapters: AdapterResolver = () => new AcpPreviewAdapter();

/** Daemon wiring: each known harness gets its own adapter; an unknown agent is an error. */
export const harnessAdapters: AdapterResolver = (agent: AcpAgentDefinition): Adapter => {
    switch (agent.id) {
        case "codex":
            return new CodexAdapter();
        case "claude":
            return new ClaudeAdapter();
        case "pi":
            return new PiAdapter();
        default:
            throw new AcpExecutionError(
                `Agent "${agent.id}" has no adapter for previewing saved sessions.`,
                {},
                "agent_adapter_not_found",
            );
    }
};
