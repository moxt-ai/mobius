import { resolve } from "node:path";
import type { Command } from "commander";

import { openMobiusCliInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import type { CliContext } from "../../context.ts";
import { valueOption } from "../../util/options.ts";
import type { PairListOptions } from "./logic/options.ts";
import { formatPairTable, savedPairSummary, writePairList } from "./logic/pair-list-output.ts";

export function registerPairListCommand(command: Command, context: CliContext): void {
    command
        .command("list")
        .description("list saved pairings")
        .addOption(valueOption("--output-json <existing-file.json>", "write JSON to an existing file"))
        .action(async (options: PairListOptions) => {
            const installation = await openMobiusCliInstallation(context.shutdownSignal, process.env);
            const outputPath = options.outputJson === undefined ? null : resolve(options.outputJson);
            const pairs = (await installation.listConnections(context.shutdownSignal))
                .map(savedPairSummary)
                .sort(
                    (left, right) =>
                        left.appId.localeCompare(right.appId) || left.connectionId.localeCompare(right.connectionId),
                );
            if (outputPath === null) {
                process.stdout.write(formatPairTable(pairs));
            } else {
                await writePairList(outputPath, pairs, context.shutdownSignal);
            }
        });
}
