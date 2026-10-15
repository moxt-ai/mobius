#!/usr/bin/env node

import { Command, CommanderError } from "commander";
import packageMetadata from "../../package.json" with { type: "json" };

import type { CliContext } from "./context.ts";
import { registerAgentsHandler } from "./handler/agents/index.ts";
import { registerDaemonLifecycleHandlers, registerInternalDaemonHandlers } from "./handler/daemon/index.ts";
import { registerPairHandlers } from "./handler/pair/index.ts";
import { registerVersionHandler } from "./handler/version/index.ts";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());
const context: CliContext = {
    shutdownSignal: shutdown.signal,
    version: packageMetadata.version,
};

function createProgram(cliContext: CliContext): Command {
    const program = new Command()
        .name("mobius")
        .description("Pair and run local AI agent services.")
        .version(cliContext.version, "-v, --version", "print the installed Mobius CLI version")
        .showHelpAfterError()
        .exitOverride()
        .addHelpText(
            "after",
            "\nPairing grants this browser access to the machine with your user account's permissions.\nNew conversations default to this Mobius installation's private workspace; choose other directories in the browser.\n",
        );

    program.action(() => program.outputHelp());
    registerVersionHandler(program, cliContext);
    registerAgentsHandler(program, cliContext);
    registerInternalDaemonHandlers(program, cliContext);
    registerPairHandlers(program, cliContext);
    registerDaemonLifecycleHandlers(program, cliContext);
    return program;
}

async function main(): Promise<void> {
    await createProgram(context).parseAsync(process.argv);
}

try {
    await main();
} catch (error) {
    if (error instanceof CommanderError) {
        process.exitCode = error.exitCode;
    } else if (!shutdown.signal.aborted) {
        const message = error instanceof Error ? error.message : "Unknown failure";
        process.stderr.write(`Mobius daemon failed: ${message}\n`);
        process.exitCode = 1;
    }
}
