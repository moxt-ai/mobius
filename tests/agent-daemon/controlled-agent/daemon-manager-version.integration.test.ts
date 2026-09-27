import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import cliPackage from "../../../packages/cli/package.json" with { type: "json" };
import { runManager } from "../../../packages/cli/src/daemon-manager.ts";
import { openMobiusCliInstallation } from "../../../packages/cli/src/pairing/pair-local-machine.ts";

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
            const started = await runCli(["start"], environment, AbortSignal.timeout(15_000));

            expect(started.code).toBe(0);
            expect(started.stderr).toBe("");
            expect(started.stdout).toContain(`Starting mobius daemon ${cliPackage.version}\n`);
            expect(started.stdout).toContain(`Mobius daemon ${cliPackage.version} started\n`);
            expect(started.stdout).toContain("Mobius daemon is running.\n");

            const ensured = await runCli(["start"], environment, AbortSignal.timeout(15_000));
            expect(ensured).toEqual({ code: 0, stderr: "", stdout: "Mobius daemon is running.\n" });
        } finally {
            await runCli(["quit"], environment, AbortSignal.timeout(10_000)).catch(() => undefined);
        }
    });

    it.skipIf(process.platform === "win32")(
        "Given an older manager owns the installation, When the current CLI lists pairings, Then it replaces the manager before serving the command",
        async () => {
            const stateRoot = await mkdtemp(join(tmpdir(), "mobius-manager-version-"));
            temporaryDirectories.push(stateRoot);
            const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: stateRoot };
            const deadline = AbortSignal.timeout(15_000);
            const installation = await openMobiusCliInstallation(deadline, environment);
            const socketName = basename(controlSocketPath(installation.stateDirectory));
            const socketReady = waitForDirectoryEntry(tmpdir(), socketName, deadline);
            const oldManagerController = new AbortController();
            const oldManager = runManager(installation, "0.0.1-test", oldManagerController.signal);

            try {
                await socketReady;

                const listed = await runCli(["pair", "list"], environment, deadline);

                expect(listed.code).toBe(0);
                expect(listed.stderr).toBe("");
                expect(listed.stdout).toContain(`Starting mobius daemon ${cliPackage.version}\n`);
                expect(listed.stdout).toContain(`Mobius daemon ${cliPackage.version} started\n`);
                expect(listed.stdout).toContain("| connection_id");
                await expect(oldManager).resolves.toBeUndefined();
            } finally {
                oldManagerController.abort();
                await runCli(["quit"], environment, AbortSignal.timeout(10_000)).catch(() => undefined);
                await oldManager.catch(() => undefined);
            }
        },
    );

    it.skipIf(process.platform === "win32")(
        "Given another control client remains connected, When the CLI quits, Then the manager exits before reporting success",
        async () => {
            const stateRoot = await mkdtemp(join(tmpdir(), "mobius-manager-quit-"));
            temporaryDirectories.push(stateRoot);
            const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: stateRoot };
            const deadline = AbortSignal.timeout(15_000);
            const installation = await openMobiusCliInstallation(deadline, environment);
            const socketName = basename(controlSocketPath(installation.stateDirectory));
            const socketReady = waitForDirectoryEntry(tmpdir(), socketName, deadline);
            const managerController = new AbortController();
            const manager = runManager(installation, "0.0.92", managerController.signal);
            let heldConnection: Socket | undefined;

            try {
                await socketReady;
                heldConnection = await holdControlConnection(installation.stateDirectory, deadline);

                const quit = await runCli(["quit"], environment, deadline);

                expect(quit).toEqual({ code: 0, stderr: "", stdout: "Mobius daemon stopped.\n" });
                await expect(readFile(join(installation.stateDirectory, "manager.lock"), "utf8")).rejects.toMatchObject(
                    {
                        code: "ENOENT",
                    },
                );
                await expect(manager).resolves.toBeUndefined();
            } finally {
                heldConnection?.destroy();
                managerController.abort();
                await manager.catch(() => undefined);
            }
        },
    );
});

describe("Mobius pairing lifecycle", () => {
    it("Given a standalone saved pairing, When it is stopped and removed by connection ID, Then list shows it stopped before removing it", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-manager-pairing-lifecycle-"));
        temporaryDirectories.push(stateRoot);
        const executableDirectory = join(stateRoot, "empty-path");
        const workspace = join(stateRoot, "workspace");
        await Promise.all([mkdir(executableDirectory), mkdir(workspace)]);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: stateRoot, PATH: executableDirectory };
        const deadline = AbortSignal.timeout(60_000);
        const installation = await openMobiusCliInstallation(deadline, environment);
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

        try {
            const initiallyListed = await runCli(["pair", "list"], environment, deadline);
            expect(initiallyListed.code).toBe(0);
            expect(initiallyListed.stdout).toContain("| connection_id");
            expect(initiallyListed.stdout).not.toContain("channel_id");
            expect(initiallyListed.stdout).toContain(connection.connectionId);
            expect(initiallyListed.stdout).toContain("app_test");

            const outputPath = join(stateRoot, "pairings.json");
            await writeFile(outputPath, "", { mode: 0o600 });
            const listedAsJson = await runCli(["pair", "list", `--output-json=${outputPath}`], environment, deadline);
            expect(listedAsJson).toEqual({ code: 0, stderr: "", stdout: "" });
            expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual([
                {
                    app_id: "app_test",
                    connection_id: connection.connectionId,
                    runtime_id: "runtime_test",
                    status: "reconnecting",
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

async function waitForDirectoryEntry(directory: string, entry: string, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve_, reject) => {
        const watcher = watch(directory, { encoding: "utf8", signal }, (_event, filename) => {
            if (filename === entry) {
                watcher.close();
                resolve_();
            }
        });
        watcher.once("error", reject);
    });
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
        socket.write(`${JSON.stringify({ kind: "list", token })}\n`);
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
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
    const cliPath = resolve(import.meta.dirname, "../../../packages/cli/src/cli.ts");
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
