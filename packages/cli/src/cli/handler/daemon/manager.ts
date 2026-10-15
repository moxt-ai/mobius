import type { Command } from "commander";

import { runManager } from "../../../daemon/lifecycle/manager.ts";
import { openMobiusControlInstallation } from "../../../pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";

export function registerManagerCommand(program: Command, context: CliContext): void {
    program.command("__manager", { hidden: true }).action(async () => {
        const installation = await openMobiusControlInstallation(context.shutdownSignal, process.env);
        await runManager(installation.stateDirectory, context.shutdownSignal);
    });
}
