import type { Command } from "commander";
import { discoverLocalAgentInventory } from "../../../agent/discovery/discover-local-agents.ts";
import { openMobiusCliInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import { loadDefaultWorkspace, RuntimeLocalContext } from "../../../runtime/config.ts";
import { ensurePrivateDirectory } from "../../../storage/files/local-files.ts";
import type { CliContext } from "../../context.ts";
import { formatAgentDiagnostics } from "./logic/agent-diagnostics.ts";

interface AgentOptions {
    readonly json?: boolean;
    readonly verbose?: boolean;
}

export function registerAgentsHandler(program: Command, context: CliContext): void {
    program
        .command("agents")
        .description("show detected, missing, and integration-ready Agents")
        .option("--json", "write the Agent inventory as JSON")
        .option("--verbose", "include per-Agent detection timing")
        .action(async (options: AgentOptions) => {
            const installation = await openMobiusCliInstallation(context.shutdownSignal, process.env);
            const localContext = new RuntimeLocalContext(installation.stateDirectory, process.env);
            const defaultWorkspace = loadDefaultWorkspace(localContext.environment);
            await ensurePrivateDirectory(defaultWorkspace);
            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace,
                environment: localContext.environment,
                signal: context.shutdownSignal,
            });
            process.stdout.write(formatAgentDiagnostics(inventory, options.json === true, options.verbose === true));
        });
}
