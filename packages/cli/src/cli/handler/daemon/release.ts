import type { Command } from "commander";

import { releaseIdleAgentProcesses } from "../../../daemon/lifecycle/daemon.ts";
import { openMobiusControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";

export function registerReleaseCommand(program: Command, context: CliContext): void {
    program
        .command("release")
        .description("release idle Agent sessions so the Agent's own app can continue them")
        .action(async () => {
            const control = await openMobiusControlInstallation(context.shutdownSignal, process.env);
            await releaseIdleAgentProcesses(control.stateDirectory, context.shutdownSignal);
            process.stdout.write("Idle Agent sessions were released. Continuing them in Morty reopens them.\n");
        });
}
