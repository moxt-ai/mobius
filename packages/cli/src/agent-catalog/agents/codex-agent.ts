import { ManagedNpmPackageDefinition } from "../../agent-installation/managed-npm-package.ts";
import { BridgedAcpAgentDefinition } from "../agent-specification.ts";

export class CodexAgentSpecification extends BridgedAcpAgentDefinition {
    readonly adapterEnvironmentVariable = "CODEX_PATH";
    readonly adapterOverrideVariable = "MOBIUS_CODEX_ACP_PATH";
    readonly adapterPackageDefinition = new ManagedNpmPackageDefinition(
        "@agentclientprotocol/codex-acp",
        "1.8.0",
        "codex-acp",
    );
    readonly agentExecutable = "codex";
    readonly agentOverrideVariable = "MOBIUS_CODEX_PATH";
    readonly id = "codex";
    readonly label = "Codex";
    readonly managedAdapterExecutablePath = [
        "adapters",
        "codex",
        "1.8.0",
        "node_modules",
        "@agentclientprotocol",
        "codex-acp",
        "dist",
        "index.js",
    ];
    readonly managedAgentExecutablePath = ["agents", "codex", "bin", "codex"];
}
