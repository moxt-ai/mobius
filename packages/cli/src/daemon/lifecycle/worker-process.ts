import { isAbsolute } from "node:path";

import { resolveLaunchFiles } from "../../engine/util/process/local-executable.ts";
import { type WorkerLaunch, workerLaunch } from "../control/protocol.ts";

export async function decodeWorkerLaunch(value: unknown): Promise<WorkerLaunch> {
    const { entry, executable, version } = workerLaunch.parse(value);
    if (!isAbsolute(entry) || !isAbsolute(executable)) {
        throw new Error("Worker launch paths must be absolute");
    }
    const resolved = await resolveLaunchFiles(entry, executable);
    if (resolved === null) {
        throw new Error("Worker launch paths must be files");
    }
    return { entry: resolved.entry, executable: resolved.executable, version };
}
