import { spawn } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedRuntimeStatus } from "./daemon-manager-protocol.ts";
import { DaemonWorkerError, decodeWorkerEvent } from "./daemon-worker-protocol.ts";
import type { VerifiedRuntimeConnection } from "./storage/runtime-installation-store.ts";

const START_TIMEOUT_MILLISECONDS = 120_000;

export interface ActiveRuntime {
    readonly connection: VerifiedRuntimeConnection;
    readonly controller: AbortController;
    readonly completion: Promise<void>;
    readonly started: Promise<void>;
    readonly ready: Promise<void>;
    readonly resolveReady: () => void;
    status: ManagedRuntimeStatus;
}

export function startWorkerProcess(
    connection: VerifiedRuntimeConnection,
    signal: AbortSignal,
    onExit: (active: ActiveRuntime) => void,
): ActiveRuntime {
    signal.throwIfAborted();
    const controller = new AbortController();
    const stopForManager = (): void => controller.abort();
    signal.addEventListener("abort", stopForManager, { once: true });
    const readiness = Promise.withResolvers<void>();
    void readiness.promise.catch(() => undefined);
    const started = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<void>();
    const active: ActiveRuntime = {
        connection,
        controller,
        completion: completion.promise,
        started: started.promise,
        ready: readiness.promise,
        resolveReady: readiness.resolve,
        status: "starting",
    };
    const cli = fileURLToPath(new URL(`./cli${extname(import.meta.url)}`, import.meta.url));
    const child = spawn(process.execPath, [cli, "__worker", "--connection", connection.connectionId], {
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let failure: Error | undefined;
    const stop = (): void => {
        if (child.connected) {
            child.send({ kind: "stop" }, (error) => {
                if (error !== null && child.connected) {
                    child.disconnect();
                }
            });
        }
    };
    controller.signal.addEventListener("abort", stop, { once: true });
    const startupTimeout = setTimeout(() => {
        failure = new DaemonWorkerError("worker_start_timeout", "Daemon worker startup timed out");
        stop();
    }, START_TIMEOUT_MILLISECONDS);
    child.on("message", (value: unknown) => {
        try {
            const event = decodeWorkerEvent(value);
            if (event.kind === "failed") {
                failure = new DaemonWorkerError(event.code, event.message);
                return;
            }
            clearTimeout(startupTimeout);
            active.status = event.status;
            started.resolve();
            if (event.status === "online") {
                active.resolveReady();
            }
        } catch (cause) {
            failure =
                cause instanceof Error
                    ? cause
                    : new DaemonWorkerError("worker_protocol_invalid", "Invalid daemon worker event");
            stop();
        }
    });
    child.once("error", (cause) => {
        failure = cause;
    });
    child.once("close", (code, exitSignal) => {
        clearTimeout(startupTimeout);
        signal.removeEventListener("abort", stopForManager);
        controller.signal.removeEventListener("abort", stop);
        if (!controller.signal.aborted) {
            active.status = "failed";
            process.stderr.write(
                `Runtime ${connection.connectionId} failed: ${failure?.message ?? `Worker exited (${code ?? exitSignal})`}\n`,
            );
        } else {
            active.status = "stopped";
        }
        onExit(active);
        started.resolve();
        readiness.reject(
            failure ??
                new DaemonWorkerError(
                    controller.signal.aborted ? "worker_stopped" : "worker_exited",
                    controller.signal.aborted
                        ? "The daemon worker stopped"
                        : "The daemon worker exited before connecting",
                ),
        );
        completion.resolve();
    });
    return active;
}

export async function waitForReady(active: ActiveRuntime, signal: AbortSignal): Promise<void> {
    if (active.status === "online") {
        return;
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(START_TIMEOUT_MILLISECONDS)]);
    await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(deadline.reason);
        active.ready.then(resolve, reject).finally(() => deadline.removeEventListener("abort", abort));
        deadline.addEventListener("abort", abort, { once: true });
    });
    if (active.status === "failed" || active.status === "stopped") {
        throw new DaemonWorkerError("worker_not_online", "The Runtime stopped or failed before connecting");
    }
}
