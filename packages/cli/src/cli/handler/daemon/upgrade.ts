import type { Command } from "commander";
import { ensureDaemon, stopDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMobiusControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";

export function registerUpgradeCommand(program: Command, context: CliContext): void {
    program
        .command("restart")
        .alias("upgrade")
        .description("restart the daemon using the latest release")
        .action(async () => {
            const control = await openMobiusControlInstallation(context.shutdownSignal, process.env);
            await stopDaemon(control.stateDirectory, context.shutdownSignal);
            const version = await ensureDaemon(control.stateDirectory, context.version, context.shutdownSignal);
            process.stdout.write(`Mobius daemon ${version} restarted.\n`);
        });
}
