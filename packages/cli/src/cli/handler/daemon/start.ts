import type { Command } from "commander";

import { reloadDaemon } from "../../../daemon/lifecycle/worker.ts";
import {
    openMobiusCliInstallation,
    openMobiusControlInstallation,
} from "../../../daemon/pairing/pair-local-machine.ts";
import { ensureWorkingDaemon } from "../../../daemon/upgrades/release-location.ts";
import type { CliContext } from "../../context.ts";
import { valueOption } from "../../util/options.ts";

interface StartOptions {
    readonly connection?: string;
}

export function registerStartCommand(program: Command, context: CliContext): void {
    program
        .command("start")
        .description("ensure the daemon is running and optionally activate a saved connection")
        .addOption(valueOption("--connection <connection-id>", "saved Runtime connection identifier"))
        .action(async (options: StartOptions) => {
            const installation = await openMobiusCliInstallation(context.shutdownSignal, process.env);
            if (options.connection !== undefined) {
                await installation.setConnectionActivation(options.connection, "active", context.shutdownSignal);
            }
            const control = await openMobiusControlInstallation(context.shutdownSignal, process.env);
            await ensureWorkingDaemon(control.stateDirectory, context.version, context.shutdownSignal);
            await reloadDaemon(control.stateDirectory, context.shutdownSignal);
            process.stdout.write("Mobius daemon is running.\n");
        });
}
