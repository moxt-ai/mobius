import { mkdir } from "node:fs/promises";
import type { Command } from "commander";

import { discoverLocalAgentInventory } from "../../../agent-catalog/discover-local-agents.ts";
import { DaemonLocalContext, loadDefaultWorkspace } from "../../../daemon/config.ts";
import { openMobiusCliInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
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
            const localContext = new DaemonLocalContext(installation.stateDirectory, process.env);
            const defaultWorkspace = loadDefaultWorkspace(localContext.environment);
            await mkdir(defaultWorkspace, { recursive: true, mode: 0o700 });
            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace,
                environment: localContext.environment,
                signal: context.shutdownSignal,
            });
            process.stdout.write(formatAgentDiagnostics(inventory, options.json === true, options.verbose === true));
        });
}
