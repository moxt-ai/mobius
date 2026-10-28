import { ClaudeAgentConnection } from "../../../acp/adapter/claude/agent-connection.ts";
import type { AgentConnectionFactory } from "../../../acp/connection/agent-connection.ts";
import { platformSupportFor } from "../../../util/platform/index.ts";
import { type ResolvedExecutable, resolveExecutablePath } from "../../../util/process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../../discovery/agent-discovery-context.ts";
import { InProcessAcpAgentSpecification } from "../agent-specification.ts";

export class ClaudeCodeAgentSpecification extends InProcessAcpAgentSpecification {
    readonly agentExecutable = "claude";
    readonly createConnection: AgentConnectionFactory = (options) => new ClaudeAgentConnection(options);
    readonly id = "claude";
    readonly label = "Claude Code";
    override readonly minimumSupportedAgentVersion = "2.1.273";
    override readonly maximumTestedAgentVersion = "2.1.273";

    constructor() {
        super("MOBIUS_CLAUDE_PATH");
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
