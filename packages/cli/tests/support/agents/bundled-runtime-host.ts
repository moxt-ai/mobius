import { createMobiusRuntimeEngine, loadMobiusRuntimeConnection } from "../../../src/index.ts";

// An embedding host: it runs the Runtime through the public package API and stops it on SIGTERM.
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
createMobiusRuntimeEngine(loadMobiusRuntimeConnection(), controller.signal)
    .then(async (engine) => await engine.run(controller.signal))
    .catch((error: unknown) => {
        if (!controller.signal.aborted) {
            console.error(error);
            process.exitCode = 1;
        }
    });
