import type { Command } from "commander";
import { ensureWorkingProcess } from "../../../daemon/lifecycle/manager-client.ts";
import { reloadDaemon } from "../../../daemon/lifecycle/worker.ts";
import {
    openMobiusCliInstallation,
    openMobiusControlInstallation,
    pairLocalMachine,
} from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";
import { valueOption } from "../../util/options.ts";
import { type ParsedPairOptions, pairArguments, requirePairOptions } from "./logic/options.ts";

export function registerPairAction(command: Command, context: CliContext): void {
    command
        .addOption(valueOption("--url <relay-url>", "relay HTTP or HTTPS URL"))
        .addOption(valueOption("--code <pairing-code>", "pairing code shown in the browser"))
        .addOption(valueOption("--pairing <runtime-pairing-id>", "Runtime pairing identifier"))
        .addOption(valueOption("--workspace <directory>", "default workspace directory"))
        .action(async (options: ParsedPairOptions) => {
            const requested = requirePairOptions(options, command);
            const installation = await openMobiusCliInstallation(context.shutdownSignal, process.env);
            process.stdout.write(`mobius version: ${context.version}\n`);
            const paired = await pairLocalMachine(pairArguments(requested), context.shutdownSignal);
            const connection = await installation.setConnectionActivation(
                paired.connectionId,
                "active",
                context.shutdownSignal,
            );
            const control = await openMobiusControlInstallation(context.shutdownSignal, process.env);
            await ensureWorkingProcess(control.stateDirectory, context.version, context.shutdownSignal);
            await reloadDaemon(control.stateDirectory, context.shutdownSignal);
            process.stdout.write(
                `\nLocal machine paired.\nApp ID: ${connection.appId}\nConnection ID: ${connection.connectionId}\n`,
            );
            process.stdout.write("Mobius daemon is running; connection will reconnect automatically.\n");
        });
}
