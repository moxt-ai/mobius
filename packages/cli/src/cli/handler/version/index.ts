import type { Command } from "commander";

import { readWorkingProcessVersion } from "../../../daemon/lifecycle/manager-client.ts";
import { openMobiusControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";

async function reportInstallationVersion(context: CliContext): Promise<void> {
    const control = await openMobiusControlInstallation(context.shutdownSignal, process.env);
    const daemonVersion = await readWorkingProcessVersion(control.stateDirectory, context.shutdownSignal);
    process.stdout.write(`CLI: ${context.version}\n`);
    process.stdout.write(`Daemon: ${daemonVersion ?? "not running"}\n`);
}

export function registerVersionHandler(program: Command, context: CliContext): void {
    program
        .command("version", { hidden: true })
        .description("print the installed Mobius CLI version")
        .action(() => {
            process.stdout.write(`${context.version}\n`);
        });
    program.option("-v, --version", "print the CLI and running daemon versions");
    program.action(() => {
        if (program.opts()["version"]) {
            void reportInstallationVersion(context);
            return;
        }
        program.outputHelp();
    });
}
