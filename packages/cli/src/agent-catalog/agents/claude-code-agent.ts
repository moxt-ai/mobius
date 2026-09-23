import { ManagedNpmPackageDefinition } from "../../agent-installation/managed-npm-package.ts";
import { BridgedAcpAgentDefinition } from "../agent-specification.ts";

export class ClaudeCodeAgentSpecification extends BridgedAcpAgentDefinition {
    readonly adapterEnvironmentVariable = "CLAUDE_CODE_EXECUTABLE";
    readonly adapterOverrideVariable = "MOBIUS_CLAUDE_ACP_PATH";
    readonly adapterPackageDefinition = new ManagedNpmPackageDefinition(
        "@agentclientprotocol/claude-agent-acp",
        "0.73.0",
        "claude-agent-acp",
    );
    readonly agentExecutable = "claude";
    readonly agentOverrideVariable = "MOBIUS_CLAUDE_PATH";
    readonly id = "claude";
    readonly label = "Claude Code";
    override readonly minimumSupportedAgentVersion = "2.1.273";
    override readonly maximumTestedAgentVersion = "2.1.273";
    readonly managedAdapterExecutablePath = [
        "adapters",
        "claude",
        "0.73.0",
        "node_modules",
        "@agentclientprotocol",
        "claude-agent-acp",
        "dist",
        "index.js",
    ];
    readonly managedAgentExecutablePath = ["agents", "claude", "home", ".local", "bin", "claude"];
}
