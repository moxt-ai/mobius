import type { Command } from "commander";

import { stopDaemon } from "../../../daemon/lifecycle/daemon-client.ts";
import { openMobiusControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";

export function registerQuitCommand(program: Command, context: CliContext): void {
    program
        .command("stop")
        .alias("quit")
        .description("stop the daemon and every active Runtime")
        .action(async () => {
            const installation = await openMobiusControlInstallation(context.shutdownSignal, process.env);
            await stopDaemon(installation.stateDirectory, context.shutdownSignal);
            process.stdout.write("Mobius daemon stopped.\n");
        });
}
