import type { Command } from "commander";
import { runDaemon } from "../../../daemon/lifecycle/daemon.ts";
import type { CliContext } from "../../context.ts";
import { registerQuitCommand } from "./quit.ts";
import { registerReleaseCommand } from "./release.ts";
import { registerStartCommand } from "./start.ts";
import { registerUpgradeCommand } from "./upgrade.ts";

export function registerInternalRuntimeHandlers(program: Command, context: CliContext): void {
    program.command("__daemon", { hidden: true }).action(async () => {
        await runDaemon(context.version, context.shutdownSignal);
    });
    // Released managers launch this entrypoint when their worker installs a newer release.
    // Keep their ownership contract until a public restart replaces the old manager.
    program.command("__worker", { hidden: true }).action(async () => {
        await runDaemon(context.version, context.shutdownSignal, "legacy-manager");
    });
}

export function registerDaemonProcessLifecycleHandlers(program: Command, context: CliContext): void {
    registerStartCommand(program, context);
    registerQuitCommand(program, context);
    registerReleaseCommand(program, context);
    registerUpgradeCommand(program, context);
}
