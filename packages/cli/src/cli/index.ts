import { Command, CommanderError } from "commander";
import packageMetadata from "../../package.json" with { type: "json" };
import { StateRootError, validateStateRoot } from "../storage/state-root.ts";

import type { CliContext } from "./context.ts";
import { registerAgentsHandler } from "./handler/agents/index.ts";
import { registerDaemonProcessLifecycleHandlers, registerInternalRuntimeHandlers } from "./handler/daemon/index.ts";
import { registerLogsCommand } from "./handler/logs/index.ts";
import { registerPairHandlers } from "./handler/pair/index.ts";
import { registerVersionHandler } from "./handler/version/index.ts";

function createProgram(cliContext: CliContext): Command {
    const program = new Command()
        .name("mobius")
        .description("Pair and run local AI agent services.")
        .showHelpAfterError()
        .exitOverride()
        .addHelpText(
            "after",
            "\nPairing grants this browser access to the machine with your user account's permissions.\nNew conversations default to this Mobius installation's private workspace; choose other directories in the browser.\n",
        );

    program.action(() => program.outputHelp());
    registerVersionHandler(program, cliContext);
    registerAgentsHandler(program, cliContext);
    registerLogsCommand(program, cliContext);
    registerInternalRuntimeHandlers(program, cliContext);
    registerPairHandlers(program, cliContext);
    registerDaemonProcessLifecycleHandlers(program, cliContext);
    return program;
}

export async function runCLI(): Promise<void> {
    const shutdown = new AbortController();
    const abort = (): void => shutdown.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const context: CliContext = {
        shutdownSignal: shutdown.signal,
        version: packageMetadata.version,
    };
    try {
        await validateStateRoot(process.env);
        await createProgram(context).parseAsync(process.argv);
    } catch (error) {
        if (error instanceof CommanderError) {
            process.exitCode = error.exitCode;
        } else if (error instanceof StateRootError) {
            process.stderr.write(`${error.message}\n`);
            // EX_CONFIG from sysexits(3): the configuration, not the command, must change.
            process.exitCode = 78;
        } else if (!shutdown.signal.aborted) {
            const message = error instanceof Error ? error.message : "Unknown failure";
            process.stderr.write(`Mobius daemon failed: ${message}\n`);
            process.exitCode = 1;
        }
    } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
    }
}
