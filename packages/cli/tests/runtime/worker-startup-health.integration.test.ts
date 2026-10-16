import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerProcess } from "../../src/daemon/lifecycle/worker-process.ts";
import type { DaemonTimer } from "../../src/relay-connection/timer.ts";

const directories: string[] = [];
afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function startWorker(): Promise<{
    readonly worker: WorkerProcess;
    readonly observing: Promise<void>;
    readonly controller: AbortController;
}> {
    vi.useFakeTimers({ now: new Date("2026-10-16T00:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const directory = await mkdtemp(join(tmpdir(), "mobius-worker-health-"));
    directories.push(directory);
    const entry = join(directory, "worker.mjs");
    await writeFile(
        entry,
        `
process.on("disconnect", () => process.exit(0));
process.send({ kind: "worker-ready", version: "99.0.1" });
`,
    );
    const observing = Promise.withResolvers<void>();
    const timer: DaemonTimer = {
        schedule: (callback, milliseconds) => {
            const timeout = setTimeout(callback, milliseconds);
            observing.resolve();
            return { cancel: () => clearTimeout(timeout) };
        },
    };
    const controller = new AbortController();
    const worker = new WorkerProcess(
        { executable: process.execPath, entry, version: "99.0.1" },
        controller.signal,
        process.env,
        timer,
    );
    return { worker, observing: observing.promise, controller };
}

it("Given a worker announces readiness, When it remains alive for the full health observation, Then startup succeeds only after five seconds", async () => {
    const { worker, observing } = await startWorker();
    let ready = false;
    const outcome = worker.ready.then(() => {
        ready = true;
    });
    try {
        await observing;
        await vi.advanceTimersByTimeAsync(4_999);
        expect(ready).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await outcome;
        expect(ready).toBe(true);
        expect(worker.running).toBe(true);
    } finally {
        await worker.close();
    }
});

it("Given a worker announces readiness, When it exits during health observation, Then startup fails instead of reporting success", async () => {
    const { worker, observing } = await startWorker();
    const outcome = worker.ready.catch((cause: unknown) => cause);
    try {
        await observing;
        process.kill(worker.pid, "SIGTERM");
        await expect(outcome).resolves.toMatchObject({ code: "worker_exited" });
    } finally {
        await worker.close();
    }
});

it("Given a worker is being observed, When startup is cancelled, Then cancellation is preserved and the process is released", async () => {
    const { worker, observing, controller } = await startWorker();
    const outcome = worker.ready.catch((cause: unknown) => cause);
    try {
        await observing;
        const reason = new Error("Startup cancelled");
        controller.abort(reason);
        await expect(outcome).resolves.toBe(reason);
    } finally {
        await worker.close();
    }
});
