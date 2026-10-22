import { spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it } from "vitest";

import { sendLocalRequest } from "../../src/daemon/control/local-client.ts";
import { openMobiusControlInstallation } from "../../src/daemon/pairing/pair-local-machine.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

async function runCli(
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
    const child = spawn(
        process.execPath,
        [resolve(import.meta.dirname, "../../src/cli/entrypoint.ts"), ...arguments_],
        {
            env: environment,
            signal,
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve_, reject) => {
        child.once("error", reject);
        child.once("exit", resolve_);
    });
    return { code, stderr, stdout };
}

function waitForLogEntries(
    path: string,
    deadline: AbortSignal,
    isComplete: (content: string) => boolean,
): Promise<string> {
    return new Promise<string>((resolve_, reject) => {
        let settled = false;
        let watcher: FSWatcher | undefined;
        const probe = (): void => {
            void readFile(path, "utf8").then(
                (content) => {
                    if (isComplete(content)) {
                        cleanup();
                        resolve_(content);
                    }
                },
                () => undefined,
            );
        };
        const startWatching = (): void => {
            watcher = watch(dirname(path), (_event, filename) => {
                if (filename === basename(path)) {
                    probe();
                }
            });
            watcher.once("error", (cause) => {
                cleanup();
                reject(cause);
            });
            probe();
        };
        const abort = (): void => {
            cleanup();
            reject(deadline.reason);
        };
        function cleanup(): void {
            if (settled) {
                return;
            }
            settled = true;
            watcher?.close();
            deadline.removeEventListener("abort", abort);
        }
        // The manager creates the logs directory on demand, so it may not exist yet.
        mkdir(dirname(path), { recursive: true }).then(startWatching, reject);
        deadline.addEventListener("abort", abort, { once: true });
    });
}

function waitForReplacement(
    stateDirectory: string,
    deadline: AbortSignal,
    previousPid: number,
): Promise<{ kind: string; worker: { pid: number; version: string } | null }> {
    return new Promise((resolve_, reject) => {
        let settled = false;
        const watcher = watch(stateDirectory, (_event, filename) => {
            if (filename !== "worker.lock") {
                return;
            }
            void readFile(join(stateDirectory, "worker.lock"), "utf8").then(
                (content) => {
                    const pid = Number(content);
                    if (Number.isSafeInteger(pid) && pid !== previousPid) {
                        void sendLocalRequest(stateDirectory, "manager", { kind: "status" }, deadline).then(
                            (status) => {
                                cleanup();
                                resolve_(status as { kind: string; worker: { pid: number; version: string } | null });
                            },
                            (cause) => {
                                cleanup();
                                reject(cause);
                            },
                        );
                    }
                },
                () => undefined,
            );
        });
        const abort = (): void => {
            cleanup();
            reject(deadline.reason);
        };
        function cleanup(): void {
            if (settled) {
                return;
            }
            settled = true;
            watcher.close();
            deadline.removeEventListener("abort", abort);
        }
        watcher.once("error", (cause) => {
            cleanup();
            reject(cause);
        });
        deadline.addEventListener("abort", abort, { once: true });
    });
}

it("Given a running daemon, When its worker is killed by an unhandled signal, Then the lifecycle log records the death and the replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-worker-lifecycle-"));
    temporaryDirectories.push(directory);
    const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: directory };
    const deadline = AbortSignal.timeout(60_000);
    try {
        expect((await runCli(["start"], environment, deadline)).code).toBe(0);
        const control = await openMobiusControlInstallation(deadline, environment);
        const workerPid = Number(await readFile(join(control.stateDirectory, "worker.lock"), "utf8"));
        const logPath = join(control.stateDirectory, "logs", "worker-lifecycle.log");
        const complete = waitForLogEntries(
            logPath,
            deadline,
            (content) =>
                content.includes('"kind":"worker_exited"') &&
                content.includes('"signal":"SIGHUP"') &&
                content.split('"kind":"worker_ready"').length >= 3,
        );
        process.kill(workerPid, "SIGHUP");
        const entries = await complete;
        expect(entries).toContain(`"pid":${workerPid}`);
        expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).not.toBe(`${workerPid}\n`);
    } finally {
        await runCli(["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
    }
}, 90_000);

it("Given a running daemon, When an unhandled rejection escapes inside its worker, Then the worker survives and the rejection is recorded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-worker-unhandled-rejection-"));
    temporaryDirectories.push(directory);
    const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: directory };
    const deadline = AbortSignal.timeout(60_000);
    try {
        expect((await runCli(["start"], environment, deadline)).code).toBe(0);
        const control = await openMobiusControlInstallation(deadline, environment);
        const workerPid = Number(await readFile(join(control.stateDirectory, "worker.lock"), "utf8"));
        // A controlled worker entry that composes the production runWorker and
        // then lets a promise reject with nothing waiting on it.
        const entry = join(directory, "unhandled-rejection-worker.mjs");
        await writeFile(
            entry,
            [
                `import { runWorker } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "../../src/daemon/lifecycle/worker.ts")).href)};`,
                `void runWorker("99.0.1", AbortSignal.timeout(60_000));`,
                `Promise.reject(new Error("controlled-unhandled-rejection-marker"));`,
                `process.on("SIGTERM", () => process.exit(0));`,
                "",
            ].join("\n"),
        );
        const rejectionLogPath = join(control.stateDirectory, "logs", "unhandled-rejections-worker.log");
        const recorded = waitForLogEntries(rejectionLogPath, deadline, (content) =>
            content.includes("controlled-unhandled-rejection-marker"),
        );
        const replacement = await sendLocalRequest(
            control.stateDirectory,
            "manager",
            {
                kind: "ensure",
                launch: { executable: process.execPath, entry, version: "99.0.1" },
            },
            deadline,
        );
        const status = replacement as { kind: string; worker: { pid: number } | null };
        expect(status.kind).toBe("status");
        expect(status.worker).not.toBeNull();
        expect(status.worker?.pid).not.toBe(workerPid);
        const committedWorkerPid = status.worker?.pid;
        // The rejection is observable in the dedicated local log while the
        // worker keeps answering control requests with the same pid.
        expect(await recorded).toContain("controlled-unhandled-rejection-marker");
        const after = (await sendLocalRequest(control.stateDirectory, "manager", { kind: "status" }, deadline)) as {
            worker: { pid: number } | null;
        };
        expect(after.worker?.pid).toBe(committedWorkerPid);
    } finally {
        await runCli(["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
    }
}, 90_000);

it("Given a state directory whose logs path is a regular file, When the manager starts, Then startup still succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-lifecycle-init-"));
    temporaryDirectories.push(directory);
    const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: directory };
    const deadline = AbortSignal.timeout(60_000);
    try {
        // The lifecycle log constructor must tolerate this: a file where the
        // logs directory should be. Startup and the control service must not
        // depend on the log being writable.
        const control = await openMobiusControlInstallation(deadline, environment);
        await mkdir(control.stateDirectory, { recursive: true });
        await writeFile(join(control.stateDirectory, "logs"), "not a directory");
        const started = await runCli(["start"], environment, deadline);
        expect(started.code).toBe(0);
        expect(started.stdout).toContain("Mobius daemon is running.");
        const status = (await sendLocalRequest(control.stateDirectory, "manager", { kind: "status" }, deadline)) as {
            kind: string;
            worker: { pid: number } | null;
        };
        expect(status.kind).toBe("status");
        expect(status.worker).not.toBeNull();
    } finally {
        await rm(join(directory, "installations"), { force: true, recursive: true }).catch(() => undefined);
        await runCli(["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
    }
}, 90_000);

it("Given a manager, When an ensured worker prints noise then dies before readiness, Then the lifecycle log keeps the fatal stderr tail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-worker-stderr-tail-"));
    temporaryDirectories.push(directory);
    const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: directory };
    const deadline = AbortSignal.timeout(60_000);
    try {
        expect((await runCli(["start"], environment, deadline)).code).toBe(0);
        const control = await openMobiusControlInstallation(deadline, environment);
        // More stderr noise than the persisted tail size, with the fatal line last.
        const entry = join(directory, "noisy-worker.mjs");
        await writeFile(
            entry,
            [
                'process.stderr.write("noise-line-early " + "x".repeat(3000) + "\\n");',
                'process.stderr.write("fatal-marker-end-of-tail\\n");',
                "process.exit(3);",
                "",
            ].join("\n"),
        );
        const logPath = join(control.stateDirectory, "logs", "worker-lifecycle.log");
        const complete = waitForLogEntries(
            logPath,
            deadline,
            (content) =>
                content.includes('"kind":"worker_start_failed"') && content.includes("fatal-marker-end-of-tail"),
        );
        // The failed ensure surfaces as a control error; the attribution lives in the log.
        await sendLocalRequest(
            control.stateDirectory,
            "manager",
            { kind: "ensure", launch: { executable: process.execPath, entry, version: "99.0.1" } },
            deadline,
        ).catch(() => undefined);
        const entries = await complete;
        expect(entries).not.toContain("noise-line-early");
        expect(entries).toContain("fatal-marker-end-of-tail");
        // The manager must survive the failed replacement and keep answering.
        const status = (await sendLocalRequest(control.stateDirectory, "manager", { kind: "status" }, deadline)) as {
            kind: string;
        };
        expect(status.kind).toBe("status");
    } finally {
        await runCli(["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
    }
}, 90_000);

it("Given a running daemon with an unwritable lifecycle log, When its worker is killed, Then the manager still recovers a replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-worker-unwritable-"));
    temporaryDirectories.push(directory);
    const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: directory };
    const deadline = AbortSignal.timeout(60_000);
    let logsDirectory = "";
    try {
        expect((await runCli(["start"], environment, deadline)).code).toBe(0);
        const control = await openMobiusControlInstallation(deadline, environment);
        logsDirectory = join(control.stateDirectory, "logs");
        const workerPid = Number(await readFile(join(control.stateDirectory, "worker.lock"), "utf8"));
        // The manager already wrote entries; replace the file with a directory so
        // every lifecycle write now fails.
        await rm(join(logsDirectory, "worker-lifecycle.log"), { force: true });
        await mkdir(join(logsDirectory, "worker-lifecycle.log"));
        process.kill(workerPid, "SIGHUP");
        // The replacement must appear and answer even though lifecycle writes fail.
        const status = await waitForReplacement(control.stateDirectory, deadline, workerPid);
        expect(status.worker).not.toBeNull();
        expect(status.worker?.pid).not.toBe(workerPid);
    } finally {
        await rm(join(logsDirectory, "worker-lifecycle.log"), { force: true, recursive: true }).catch(() => undefined);
        await runCli(["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
    }
}, 90_000);
