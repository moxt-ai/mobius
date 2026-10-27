import type { Command } from "commander";

import { ensureWorkingProcess, readWorkingProcessVersion } from "../../../daemon/lifecycle/manager-client.ts";
import { reloadDaemon } from "../../../daemon/lifecycle/worker.ts";
import { openMobiusControlInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import { DaemonReleaseUpgradeError } from "../../../daemon/upgrades/package.ts";
import { awaitDaemonReleaseSwitch, requestDaemonReleaseUpgrade } from "../../../daemon/upgrades/upgrade.ts";
import type { CliContext } from "../../context.ts";

export function registerUpgradeCommand(program: Command, context: CliContext): void {
    program
        .command("upgrade")
        .description("start the daemon if needed and upgrade it to the newest npm release")
        .action(async () => {
            const signal = context.shutdownSignal;
            const control = await openMobiusControlInstallation(signal, process.env);
            // Keep an already-running daemon, even when it is newer than this CLI.
            const current =
                (await readWorkingProcessVersion(control.stateDirectory, signal)) ??
                (await ensureWorkingProcess(control.stateDirectory, context.version, signal));
            await reloadDaemon(control.stateDirectory, signal);
            const attempt = await requestDaemonReleaseUpgrade(control.stateDirectory, current, signal);
            if (attempt.kind === "current") {
                process.stdout.write(`Mobius daemon ${current} is already the newest release.\n`);
                return;
            }
            process.stdout.write(`Upgrading Mobius daemon to ${attempt.version}...\n`);
            const outcome = await awaitDaemonReleaseSwitch(control.stateDirectory, attempt.id, signal);
            if (outcome.kind === "switched") {
                process.stdout.write(`Mobius daemon upgraded to ${attempt.version}.\n`);
                return;
            }
            throw new DaemonReleaseUpgradeError(
                outcome.code,
                `The upgrade to ${attempt.version} failed and ${outcome.previous.version} was restored: ${outcome.message}`,
            );
        });
}
