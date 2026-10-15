import { runDaemonEntrypoint } from "../daemon/lifecycle/entrypoint.ts";
import { runManager } from "../daemon/lifecycle/manager.ts";
import { openMobiusControlInstallation } from "../pairing/pair-local-machine.ts";

await runDaemonEntrypoint(async (signal) => {
    const control = await openMobiusControlInstallation(signal, process.env);
    await runManager(control.stateDirectory, signal);
});
