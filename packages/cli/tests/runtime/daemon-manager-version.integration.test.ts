import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import cliPackage from "../../package.json" with { type: "json" };
import { openMobiusCliInstallation, openMobiusControlInstallation } from "../../src/pairing/pair-local-machine.ts";
import { platformSupportFor } from "../../src/platform/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

describe("Mobius manager version compatibility", () => {
    it("Given the daemon is stopped, When the user runs mobius start, Then the daemon is running without requiring a connection", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-manager-start-"));
        temporaryDirectories.push(stateRoot);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: stateRoot };

        try {
            const started = await runCli(["start"], environment, AbortSignal.timeout(60_000));

            expect(started.code).toBe(0);
            expect(started.stderr).toBe("");
            expect(started.stdout).toContain(`Starting mobius daemon ${cliPackage.version}\n`);
            expect(started.stdout).toContain(`Mobius daemon ${cliPackage.version} started\n`);
            expect(started.stdout).toContain("Mobius daemon is running.\n");

            const control = await openMobiusControlInstallation(AbortSignal.timeout(10_000), environment);
            const managerPid = Number(await readFile(join(control.stateDirectory, "manager.lock"), "utf8"));
            expect(
                (await platformSupportFor(process.platform).readProcessTable()).filter(
                    (entry) => entry.parentProcessId === managerPid,
                ),
            ).toHaveLength(1);
            const ensured = await runCli(["start"], environment, AbortSignal.timeout(60_000));
            expect(ensured).toEqual({ code: 0, stderr: "", stdout: "Mobius daemon is running.\n" });
        } finally {
            await runCli(["quit"], environment, AbortSignal.timeout(10_000)).catch(() => undefined);
        }
    });

    it("Given a running daemon, When its worker crashes, Then the manager automatically starts a replacement", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-worker-crash-"));
        temporaryDirectories.push(directory);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: directory };
        const deadline = AbortSignal.timeout(60_000);
        try {
            expect((await runCli(["start"], environment, deadline)).code).toBe(0);
            const control = await openMobiusControlInstallation(deadline, environment);
            const manager = await readFile(join(control.stateDirectory, "manager.lock"), "utf8");
            const previous = await readFile(join(control.stateDirectory, "worker.lock"), "utf8");
            const replacement = new Promise<string>((resolve_, reject) => {
                const watcher = watch(control.stateDirectory, (_event, filename) => {
                    if (filename !== "worker.lock") {
                        return;
                    }
                    void readFile(join(control.stateDirectory, "worker.lock"), "utf8").then(
                        (pid) => {
                            if (Number(pid) > 1 && pid !== previous) {
                                cleanup();
                                resolve_(pid);
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
                    watcher.close();
                    deadline.removeEventListener("abort", abort);
                }
                watcher.once("error", (cause) => {
                    cleanup();
                    reject(cause);
                });
                deadline.addEventListener("abort", abort, { once: true });
            });
            process.kill(Number(previous), "SIGKILL");
            const next = await replacement;
            expect(next).not.toBe(previous);
            expect(await readFile(join(control.stateDirectory, "manager.lock"), "utf8")).toBe(manager);
            expect((await runCli(["pair", "list"], environment, deadline)).code).toBe(0);
            expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(next);
        } finally {
            await runCli(["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
        }
    });

    it("Given no daemon is running, When saved pairings are listed, Then the CLI completes without starting a manager", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-local-list-"));
        temporaryDirectories.push(directory);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: directory };
        const deadline = AbortSignal.timeout(30_000);
        const result = await runCli(["pair", "list"], environment, deadline);
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain("Starting mobius");
        const control = await openMobiusControlInstallation(deadline, environment);
        await expect(readFile(join(control.stateDirectory, "manager.lock"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("Given saved data from another version, When the current CLI lists pairings, Then it uses its own directory and preserves existing data", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-version-data-"));
        temporaryDirectories.push(directory);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: directory };
        const oldDirectory = join(directory, "versions", "0.0.1");
        await mkdir(oldDirectory, { recursive: true });
        await writeFile(join(oldDirectory, "retained.sqlite"), "old-version-data");
        const deadline = AbortSignal.timeout(30_000);
        expect((await runCli(["pair", "list"], environment, deadline)).code).toBe(0);
        const installation = await openMobiusCliInstallation(deadline, environment);
        expect(
            installation.stateDirectory.startsWith(`${join(directory, "versions", cliPackage.version)}/`) ||
                installation.stateDirectory.startsWith(`${join(directory, "versions", cliPackage.version)}\\`),
        ).toBe(true);
        expect(await readFile(join(oldDirectory, "retained.sqlite"), "utf8")).toBe("old-version-data");
        await expect(
            readFile(join(directory, "versions", cliPackage.version, "retained.sqlite")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("Given an installed daemon, When another CLI version starts, Then only the working process changes", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-worker-upgrade-"));
        temporaryDirectories.push(directory);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: join(directory, "state") };
        const deadline = AbortSignal.timeout(90_000);
        const release = join(directory, "release");
        await cp(resolve(import.meta.dirname, "../../src"), join(release, "src"), { recursive: true });
        await writeFile(join(release, "package.json"), JSON.stringify({ ...cliPackage, version: "0.0.227-test" }));
        await symlink(resolve(import.meta.dirname, "../../node_modules"), join(release, "node_modules"), "junction");
        try {
            expect((await runCli(["start"], environment, deadline)).code).toBe(0);
            const control = await openMobiusControlInstallation(deadline, environment);
            const manager = await readFile(join(control.stateDirectory, "manager.lock"), "utf8");
            const worker = await readFile(join(control.stateDirectory, "worker.lock"), "utf8");
            const data = await openMobiusCliInstallation(deadline, environment);
            const saved = await data.saveConnection(
                {
                    appId: "app_isolated",
                    channelId: "channel_isolated",
                    defaultWorkspace: directory,
                    pairingId: "",
                    relayOrigin: new URL("http://127.0.0.1:1"),
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "runtime_isolated",
                },
                deadline,
            );
            await data.setConnectionActivation(saved.connectionId, "stopped", deadline);

            const upgraded = await runCli(["start"], environment, deadline, join(release, "src/cli.ts"));
            expect(upgraded).toEqual({ code: 0, stderr: "", stdout: "Mobius daemon is running.\n" });
            expect(await readFile(join(control.stateDirectory, "manager.lock"), "utf8")).toBe(manager);
            const replacement = await readFile(join(control.stateDirectory, "worker.lock"), "utf8");
            expect(replacement).not.toBe(worker);
            expect(
                (await platformSupportFor(process.platform).readProcessTable()).filter(
                    (entry) => entry.parentProcessId === Number(manager),
                ),
            ).toHaveLength(1);
            expect((await runCli(["start"], environment, deadline, join(release, "src/cli.ts"))).code).toBe(0);
            expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(replacement);
            const otherList = await runCli(["pair", "list"], environment, deadline, join(release, "src/cli.ts"));
            expect(otherList.code).toBe(0);
            expect(otherList.stdout).not.toContain(saved.connectionId);
            const originalList = await runCli(["pair", "list"], environment, deadline);
            expect(originalList.code).toBe(0);
            expect(originalList.stdout).toContain(saved.connectionId);
            expect(await readFile(data.connectionPath(saved.connectionId), "utf8")).toContain("app_isolated");
        } finally {
            await runCli(["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
        }
    });

    it("Given another control client remains connected, When the CLI quits, Then both daemon processes exit", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-manager-quit-"));
        temporaryDirectories.push(stateRoot);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: stateRoot };
        const deadline = AbortSignal.timeout(60_000);
        let heldConnection: Socket | undefined;
        try {
            expect((await runCli(["start"], environment, deadline)).code).toBe(0);
            const control = await openMobiusControlInstallation(deadline, environment);
            heldConnection = await holdControlConnection(control.stateDirectory, deadline);
            expect(await runCli(["quit"], environment, deadline)).toEqual({
                code: 0,
                stderr: "",
                stdout: "Mobius daemon stopped.\n",
            });
            for (const name of ["manager.lock", "worker.lock"]) {
                await expect(readFile(join(control.stateDirectory, name), "utf8")).rejects.toMatchObject({
                    code: "ENOENT",
                });
            }
        } finally {
            heldConnection?.destroy();
            await runCli(["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
        }
    });
});

describe("Mobius pairing lifecycle", () => {
    it("Given two saved pairings in one working daemon, When one is stopped and removed, Then the other stays available", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-manager-pairing-lifecycle-"));
        temporaryDirectories.push(stateRoot);
        const executableDirectory = join(stateRoot, "empty-path");
        const workspace = join(stateRoot, "workspace");
        await Promise.all([mkdir(executableDirectory), mkdir(workspace)]);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: stateRoot, PATH: executableDirectory };
        const deadline = AbortSignal.timeout(60_000);
        const installation = await openMobiusCliInstallation(deadline, environment);
        const control = await openMobiusControlInstallation(deadline, environment);
        const connection = await installation.saveConnection(
            {
                appId: "app_test",
                channelId: "channel_test",
                defaultWorkspace: workspace,
                pairingId: "",
                relayOrigin: new URL("http://127.0.0.1:1"),
                runtimeCredential: "a".repeat(43),
                runtimeId: "runtime_test",
            },
            deadline,
        );

        const second = await installation.saveConnection(
            {
                appId: "app_test2",
                channelId: "channel_test2",
                defaultWorkspace: workspace,
                pairingId: "",
                relayOrigin: new URL("http://127.0.0.1:1"),
                runtimeCredential: "b".repeat(43),
                runtimeId: "runtime_test2",
            },
            deadline,
        );
        try {
            expect((await runCli(["start"], environment, deadline)).code).toBe(0);
            const initiallyListed = await runCli(["pair", "list"], environment, deadline);
            expect(initiallyListed.code).toBe(0);
            expect(initiallyListed.stdout).toContain("| connection_id");
            expect(initiallyListed.stdout).not.toContain("channel_id");
            expect(initiallyListed.stdout).toContain(connection.connectionId);
            expect(initiallyListed.stdout).toContain("app_test");

            expect(initiallyListed.stdout).toContain(second.connectionId);
            const managerPid = Number(await readFile(join(control.stateDirectory, "manager.lock"), "utf8"));
            const workerPid = await readFile(join(control.stateDirectory, "worker.lock"), "utf8");
            expect(
                (await platformSupportFor(process.platform).readProcessTable()).filter(
                    (entry) => entry.parentProcessId === managerPid,
                ),
            ).toHaveLength(1);
            const outputPath = join(stateRoot, "pairings.json");
            await writeFile(outputPath, "", { mode: 0o600 });
            const listedAsJson = await runCli(["pair", "list", `--output-json=${outputPath}`], environment, deadline);
            expect(listedAsJson).toEqual({ code: 0, stderr: "", stdout: "" });
            expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual([
                {
                    app_id: "app_test",
                    connection_id: connection.connectionId,
                    runtime_id: "runtime_test",
                    status: "active",
                    workspace,
                },
                {
                    app_id: "app_test2",
                    connection_id: second.connectionId,
                    runtime_id: "runtime_test2",
                    status: "active",
                    workspace,
                },
            ]);

            const missingOutput = await runCli(
                ["pair", "list", `--output-json=${join(stateRoot, "missing.json")}`],
                environment,
                deadline,
            );
            expect(missingOutput.code).toBe(1);
            expect(missingOutput.stderr).toContain("The JSON output file does not exist");

            const stopped = await runCli(
                ["pair", "stop", "--connection", connection.connectionId],
                environment,
                deadline,
            );
            expect(stopped.code).toBe(0);
            expect(stopped.stdout).toContain(`Pairing stopped: ${connection.connectionId}\n`);

            expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(workerPid);
            const listedStopped = await runCli(["pair", "list"], environment, deadline);
            expect(listedStopped.stdout).toContain(connection.connectionId);
            expect(listedStopped.stdout).toContain("stopped");

            const quit = await runCli(["quit"], environment, deadline);
            expect(quit.code).toBe(0);
            const listedAfterRestart = await runCli(["pair", "list"], environment, deadline);
            expect(listedAfterRestart.stdout).toContain(connection.connectionId);
            expect(listedAfterRestart.stdout).toContain("stopped");

            const removed = await runCli(
                ["pair", "remove", "--connection", connection.connectionId],
                environment,
                deadline,
            );
            expect(removed.code).toBe(0);
            expect(removed.stdout).toContain(`Pairing removed: ${connection.connectionId}\n`);

            const listedRemoved = await runCli(["pair", "list"], environment, deadline);
            expect(listedRemoved.stdout).not.toContain(connection.connectionId);
            expect(listedRemoved.stdout).toContain(second.connectionId);
            await expect(readFile(join(control.stateDirectory, "manager.lock"))).rejects.toMatchObject({
                code: "ENOENT",
            });
            const stoppedOffline = await runCli(
                ["pair", "stop", "--connection", second.connectionId],
                environment,
                deadline,
            );
            expect(stoppedOffline.code).toBe(0);
            await expect(readFile(join(control.stateDirectory, "manager.lock"))).rejects.toMatchObject({
                code: "ENOENT",
            });
        } finally {
            await runCli(["quit"], environment, AbortSignal.timeout(10_000)).catch(() => undefined);
        }
    }, 75_000);
});

function controlSocketPath(stateDirectory: string): string {
    const installationHash = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 32);
    return process.platform === "win32"
        ? `\\\\.\\pipe\\mobius-${installationHash}`
        : join(tmpdir(), `mobius-${installationHash}.sock`);
}

async function holdControlConnection(stateDirectory: string, signal: AbortSignal): Promise<Socket> {
    const token = (await readFile(join(stateDirectory, "manager.token"), "utf8")).trim();
    const socket = createConnection({ allowHalfOpen: true, path: controlSocketPath(stateDirectory) });
    try {
        await new Promise<void>((resolve_, reject) => {
            const finish = (cause?: unknown): void => {
                signal.removeEventListener("abort", abort);
                socket.removeListener("connect", connected);
                socket.removeListener("error", finish);
                cause === undefined ? resolve_() : reject(cause);
            };
            const abort = (): void => finish(signal.reason);
            const connected = (): void => finish();
            socket.once("connect", connected);
            socket.once("error", finish);
            signal.addEventListener("abort", abort, { once: true });
        });
        socket.write(`${JSON.stringify({ kind: "status", token })}\n`);
        await new Promise<void>((resolve_, reject) => {
            let encoded = "";
            const finish = (cause?: unknown): void => {
                signal.removeEventListener("abort", abort);
                socket.removeListener("data", data);
                socket.removeListener("error", finish);
                cause === undefined ? resolve_() : reject(cause);
            };
            const abort = (): void => finish(signal.reason);
            const data = (chunk: Buffer): void => {
                encoded += chunk.toString("utf8");
                if (encoded.includes("\n")) {
                    finish();
                }
            };
            socket.on("data", data);
            socket.once("error", finish);
            signal.addEventListener("abort", abort, { once: true });
        });
        return socket;
    } catch (cause) {
        socket.destroy();
        throw cause;
    }
}

async function runCli(
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
    cliPath = resolve(import.meta.dirname, "../../src/cli.ts"),
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
    const child = spawn(process.execPath, [cliPath, ...arguments_], {
        env: environment,
        signal,
        stdio: ["ignore", "pipe", "pipe"],
    });
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
