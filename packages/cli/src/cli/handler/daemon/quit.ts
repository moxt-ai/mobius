import type { Command } from "commander";

import { stopManager } from "../../../daemon/lifecycle/manager-client.ts";
import { openMobiusControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";

export function registerQuitCommand(program: Command, context: CliContext): void {
    program
        .command("quit")
        .description("stop the manager and every active Runtime")
        .action(async () => {
            const installation = await openMobiusControlInstallation(context.shutdownSignal, process.env);
            await stopManager(installation.stateDirectory, context.shutdownSignal);
            process.stdout.write("Mobius daemon stopped.\n");
        });
}
