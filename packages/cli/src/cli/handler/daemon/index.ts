import type { Command } from "commander";

import type { CliContext } from "../../context.ts";
import { registerManagerCommand } from "./manager.ts";
import { registerQuitCommand } from "./quit.ts";
import { registerStartCommand } from "./start.ts";
import { registerUpgradeCommand } from "./upgrade.ts";
import { registerWorkerCommand } from "./worker.ts";

export function registerInternalRuntimeHandlers(program: Command, context: CliContext): void {
    registerManagerCommand(program, context);
    registerWorkerCommand(program, context);
}

export function registerDaemonProcessLifecycleHandlers(program: Command, context: CliContext): void {
    registerStartCommand(program, context);
    registerQuitCommand(program, context);
    registerUpgradeCommand(program, context);
}
