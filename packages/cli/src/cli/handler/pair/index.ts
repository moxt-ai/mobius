import type { Command } from "commander";

import type { CliContext } from "../../context.ts";
import { registerPairListCommand } from "./list.ts";
import { registerPairAction } from "./pair.ts";
import { registerPairRemoveCommand } from "./remove.ts";
import { registerPairStopCommand } from "./stop.ts";

export function registerPairHandlers(program: Command, context: CliContext): void {
    const pair = program.command("pair").description("pair this machine or manage saved pairings");
    registerPairAction(pair, context);
    registerPairListCommand(pair, context);
    registerPairStopCommand(pair, context);
    registerPairRemoveCommand(pair, context);
}
