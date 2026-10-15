import packageMetadata from "../../package.json" with { type: "json" };
import { runDaemonEntrypoint } from "../daemon/lifecycle/entrypoint.ts";
import { runWorker } from "../daemon/lifecycle/worker.ts";

await runDaemonEntrypoint((signal) => runWorker(packageMetadata.version, signal));
