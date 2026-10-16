import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerProcess } from "../../src/daemon/lifecycle/worker-process.ts";

const directories: string[] = [];
afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function startWorker(body: string): Promise<WorkerProcess> {
    vi.useFakeTimers({ now: new Date("2026-10-16T00:00:00Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const directory = await mkdtemp(join(tmpdir(), "mobius-worker-start-"));
    directories.push(directory);
    const entry = join(directory, "worker.mjs");
    await writeFile(entry, `process.on("disconnect", () => process.exit(0));\n${body}`);
    return new WorkerProcess(
        { executable: process.execPath, entry, version: "99.0.1" },
        new AbortController().signal,
        process.env,
    );
}

it("Given a worker completes local startup, When it announces readiness, Then startup succeeds without a stability delay", async () => {
    const worker = await startWorker('process.send({ kind: "worker-ready", version: "99.0.1" });');
    try {
        await worker.ready;
        expect(worker.running).toBe(true);
        expect(Date.now()).toBe(Date.parse("2026-10-16T00:00:00Z"));
    } finally {
        await worker.close();
    }
});

it("Given a worker fails local initialization, When it exits without readiness, Then startup still fails", async () => {
    const worker = await startWorker("process.exit(1);");
    try {
        await expect(worker.ready).rejects.toMatchObject({ code: "worker_exited" });
    } finally {
        await worker.close();
    }
});
