import type { Command } from "commander";

import { reloadDaemon } from "../../../daemon/lifecycle/daemon.ts";
import {
    openMobiusCliInstallation,
    openMobiusControlInstallation,
} from "../../../daemon/pairing/pair-local-machine.ts";
import { removeHistoricalPairingFiles } from "../../../storage/daemon/pairing-copies.ts";
import { readStateDirectory } from "../../../storage/state-directory.ts";
import type { CliContext } from "../../context.ts";
import { valueOption } from "../../util/options.ts";
import type { ConnectionOptions } from "./logic/options.ts";

export function registerPairRemoveCommand(command: Command, context: CliContext): void {
    command
        .command("remove")
        .description("remove a saved pairing")
        .addOption(valueOption("--connection <connection-id>", "saved Runtime connection identifier", true))
        .action(async (options: ConnectionOptions) => {
            const installation = await openMobiusCliInstallation(context.shutdownSignal, process.env);
            const connection = await installation.readConnection(options.connection, context.shutdownSignal);
            // Keep the authoritative record until cleanup succeeds, so a failed
            // cleanup can be retried without losing the pairing's identity.
            await removeHistoricalPairingFiles(
                readStateDirectory(),
                installation.stateDirectory,
                installation.installationId,
                connection.connectionId,
                connection.channelId,
                context.shutdownSignal,
            );
            await installation.removeConnection(options.connection, context.shutdownSignal);
            const control = await openMobiusControlInstallation(context.shutdownSignal, process.env);
            await reloadDaemon(control.stateDirectory, context.shutdownSignal);
            process.stdout.write(`Pairing removed: ${options.connection}\n`);
        });
}
