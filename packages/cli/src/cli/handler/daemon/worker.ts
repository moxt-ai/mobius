import type { Command } from "commander";

import { runWorker } from "../../../daemon/lifecycle/worker.ts";
import type { CliContext } from "../../context.ts";

export function registerWorkerCommand(program: Command, context: CliContext): void {
    program.command("__worker", { hidden: true }).action(async () => {
        await runWorker(context.version, context.shutdownSignal);
    });
}
