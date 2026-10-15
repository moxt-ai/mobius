import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { DaemonWorkerError, type WorkerEvent } from "./daemon-worker-protocol.ts";
import { openMobiusCliInstallation, resumeMobiusRuntime } from "./pairing/pair-local-machine.ts";
import { platformSupportFor } from "./platform/index.ts";
import { MobiusRuntimeEngine } from "./runtime.ts";

async function acquireWorkerLock(path: string, signal: AbortSignal): Promise<() => Promise<void>> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const owner = `${process.pid}\n`;
    for (;;) {
        deadline.throwIfAborted();
        try {
            await writeFile(path, owner, { flag: "wx", mode: 0o600 });
            return async () => {
                if ((await readFile(path, "utf8").catch(() => "")) === owner) {
                    await unlink(path);
                }
            };
        } catch (cause) {
            if (typeof cause !== "object" || cause === null || !("code" in cause) || cause.code !== "EEXIST") {
                throw cause;
            }
        }
        const previous = await readFile(path, "utf8").catch(() => "");
        const pid = Number(previous.trim());
        if (Number.isSafeInteger(pid) && pid > 1 && !platformSupportFor(process.platform).processExists(pid)) {
            await unlink(path).catch(() => undefined);
            continue;
        }
        await setTimeout(25, undefined, { signal: deadline });
    }
}

export async function runDaemonWorker(connectionId: string, signal: AbortSignal): Promise<void> {
    if (!/^mcn_[a-f0-9]{32}$/.test(connectionId) || process.send === undefined || !process.connected) {
        throw new DaemonWorkerError(
            "worker_launch_invalid",
            "Daemon workers must be launched by the manager with a valid connection",
        );
    }
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    const stop = (): void => shutdown.abort();
    const receive = (value: unknown): void => {
        if (typeof value === "object" && value !== null && "kind" in value && value.kind === "stop") {
            stop();
        } else {
            process.exitCode = 1;
            stop();
        }
    };
    const report = (event: WorkerEvent): void => {
        if (process.connected) {
            process.send?.(event, (error) => {
                if (error !== null) {
                    stop();
                }
            });
        }
    };
    process.once("disconnect", stop);
    process.on("message", receive);
    let release: (() => Promise<void>) | undefined;
    try {
        const installation = await openMobiusCliInstallation(combined, process.env);
        await installation.readConnection(connectionId, combined);
        release = await acquireWorkerLock(join(installation.stateDirectory, `${connectionId}.worker.lock`), combined);
        const paired = await resumeMobiusRuntime(
            installation,
            connectionId,
            AbortSignal.any([combined, AbortSignal.timeout(120_000)]),
        );
        const engine = new MobiusRuntimeEngine(paired.config, {
            onConnectionStatus: (status) => report({ kind: "status", status }),
        });
        report({ kind: "status", status: "reconnecting" });
        await engine.run(combined);
    } catch (cause) {
        if (!combined.aborted) {
            process.exitCode = 1;
            report({
                kind: "failed",
                code: "worker_runtime_failed",
                message: cause instanceof Error ? cause.message : "Daemon worker failed",
            });
        }
    } finally {
        try {
            await release?.();
        } finally {
            process.removeListener("message", receive);
            process.removeListener("disconnect", stop);
            if (process.connected) {
                process.disconnect();
            }
        }
    }
}
