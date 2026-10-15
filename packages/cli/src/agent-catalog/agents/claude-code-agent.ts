import { ClaudeAcpEndpoint } from "../../acp/harness/claude/endpoint.ts";
import type { InProcessAcpEndpointFactory } from "../../acp/in-process/acp-endpoint.ts";
import { platformSupportFor } from "../../platform/index.ts";
import { type ResolvedExecutable, resolveExecutablePath } from "../../util/process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../agent-discovery-context.ts";
import { InProcessAcpAgentDefinition } from "../agent-specification.ts";

export class ClaudeCodeAgentSpecification extends InProcessAcpAgentDefinition {
    readonly agentExecutable = "claude";
    readonly createEndpoint: InProcessAcpEndpointFactory = (options) => new ClaudeAcpEndpoint(options);
    readonly id = "claude";
    readonly label = "Claude Code";
    override readonly minimumSupportedAgentVersion = "2.1.273";
    override readonly maximumTestedAgentVersion = "2.1.273";

    constructor() {
        super("MOBIUS_CLAUDE_PATH", ["agents", "claude", "home", ".local", "bin", "claude"]);
    }

    override readonly resolveInstalledAgentExecutables = async (
        context: LocalAgentDiscoveryContext,
    ): Promise<readonly ResolvedExecutable[]> => {
        context.signal.throwIfAborted();
        const platform = context.platform ?? process.platform;
        const paths = platformSupportFor(platform).claudeCodeExecutablePaths(context.environment);
        const executables: ResolvedExecutable[] = [];
        for (const path of paths) {
            const executable = await resolveExecutablePath(path, platform);
            context.signal.throwIfAborted();
            if (executable !== null) {
                executables.push(executable);
            }
        }
        return executables;
    };
}
