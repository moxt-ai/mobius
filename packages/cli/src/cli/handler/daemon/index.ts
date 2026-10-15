import type { Command } from "commander";

import type { CliContext } from "../../context.ts";
import { registerQuitCommand } from "./quit.ts";
import { registerStartCommand } from "./start.ts";

export function registerDaemonLifecycleHandlers(program: Command, context: CliContext): void {
    registerStartCommand(program, context);
    registerQuitCommand(program, context);
}
