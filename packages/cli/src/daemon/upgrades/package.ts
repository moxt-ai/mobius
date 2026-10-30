import { findExecutableOnPath, runBoundedProcess } from "../../engine/util/process/executable.ts";
import type { WorkerLaunch } from "../control/protocol.ts";
import { decodeWorkerLaunch } from "../lifecycle/worker-process.ts";

export class DaemonReleaseUpgradeError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
    }
}

/** npx owns package resolution and caching; Node owns the worker IPC channel. */
export async function resolveLatestDaemonLaunch(signal: AbortSignal): Promise<WorkerLaunch> {
    const npx = await findExecutableOnPath("npx", process.env);
    if (npx === null) {
        throw new DaemonReleaseUpgradeError("npm_unavailable", "npx is required to start Mobius");
    }
    const result = await runBoundedProcess({
        command: npx.path,
        arguments: ["--yes", "--prefer-online", "@moxt-ai/mobius@latest", "__launch"],
        cwd: process.cwd(),
        environment: process.env,
        signal,
        timeoutMilliseconds: 300_000,
        outputLimitBytes: 16 * 1024,
    });
    return await decodeWorkerLaunch(JSON.parse(result.stdout));
}
