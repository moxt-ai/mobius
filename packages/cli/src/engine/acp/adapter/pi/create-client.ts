import { AcpExecutionError } from "../../acp-error.ts";
import type { AcpAgentDefinition } from "../../agent/agent-definition.ts";
import { PiAcpAgent } from "../../harness/pi/upstream/dist/acp/agent.js";
import type { PiAcpClient } from "../../harness/pi/upstream/dist/acp/client.js";
import { validateAgentRuntime } from "../agent-initialization.ts";

export type PiClientRuntime = Pick<AcpAgentDefinition, "command" | "environment" | "runtimeExecutables">;

/** Revalidate the local launch target immediately before constructing the concrete client. */
export async function createPiClient(
    runtime: PiClientRuntime,
    callbacks: PiAcpClient,
    signal: AbortSignal,
): Promise<PiAcpAgent> {
    await validateAgentRuntime(runtime, signal);
    signal.throwIfAborted();
    if (!runtime.runtimeExecutables.some((identity) => identity.realPath === runtime.command)) {
        throw new AcpExecutionError("The Pi command is not a verified runtime executable", {}, "agent_runtime_changed");
    }
    return new PiAcpAgent(callbacks, {
        environment: Object.freeze({ ...process.env, ...runtime.environment, PI_ACP_PI_COMMAND: runtime.command }),
    });
}
