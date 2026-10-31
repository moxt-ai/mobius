import { join, resolve } from "node:path";
import type { Command } from "commander";
import { openMobiusCliInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import { discoverLocalAgentInventory } from "../../../engine/agent/discovery/discover-local-agents.ts";
import { RuntimeLocalContext } from "../../../engine/runtime/config.ts";
import { ensurePrivateDirectory } from "../../../engine/storage/files/local-files.ts";
import { readStateDirectory } from "../../../storage/state-directory.ts";
import type { CliContext } from "../../context.ts";
import { valueOption } from "../../util/options.ts";
import { formatAgentDiagnostics, writeAgentDiagnostics } from "./logic/agent-diagnostics.ts";

interface AgentOptions {
    readonly json?: boolean;
    readonly outputJson?: string;
    readonly verbose?: boolean;
}

export function registerAgentsHandler(program: Command, context: CliContext): void {
    program
        .command("agents")
        .description("show detected, missing, and integration-ready Agents")
        .option("--json", "write the Agent inventory as JSON")
        .addOption(valueOption("--output-json <existing-file.json>", "write the JSON inventory to an existing file"))
        .option("--verbose", "include per-Agent detection timing")
        .action(async (options: AgentOptions) => {
            const installation = await openMobiusCliInstallation(context.shutdownSignal, process.env);
            const localContext = new RuntimeLocalContext(installation.stateDirectory, process.env);
            const defaultWorkspace = join(readStateDirectory(), "workspace");
            await ensurePrivateDirectory(defaultWorkspace);
            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace,
                dataDirectory: localContext.stateDirectory,
                environment: localContext.agentLaunchEnvironment,
                signal: context.shutdownSignal,
            });
            if (options.outputJson !== undefined) {
                await writeAgentDiagnostics(
                    resolve(options.outputJson),
                    inventory,
                    options.verbose === true,
                    context.shutdownSignal,
                );
                return;
            }
            process.stdout.write(formatAgentDiagnostics(inventory, options.json === true, options.verbose === true));
        });
}
