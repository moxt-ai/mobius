import type { Command } from "commander";
import { ensureWorkingProcess, stopManager } from "../../../daemon/lifecycle/manager-client.ts";
import { openMobiusControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";

export function registerUpgradeCommand(program: Command, context: CliContext): void {
    program
        .command("upgrade")
        .description("restart the daemon using the latest release")
        .action(async () => {
            const control = await openMobiusControlInstallation(context.shutdownSignal, process.env);
            await stopManager(control.stateDirectory, context.shutdownSignal);
            const version = await ensureWorkingProcess(control.stateDirectory, context.version, context.shutdownSignal);
            process.stdout.write(`Mobius daemon ${version} started.\n`);
        });
}
