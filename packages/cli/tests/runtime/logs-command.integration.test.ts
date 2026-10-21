import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
        [resolve(import.meta.dirname, "../../src/entrypoint/cli.ts"), ...arguments_],
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

/** Write one installation's logs, mirroring the store's `<root>/installations/<appId>/<id>/logs` layout. */
async function writeInstallationLog(
    stateDirectory: string,
    applicationId: string,
    filename: string,
    lines: readonly string[],
): Promise<void> {
    const logs = join(stateDirectory, "installations", applicationId, "min_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "logs");
    await mkdir(logs, { mode: 0o700, recursive: true });
    await writeFile(join(logs, filename), `${lines.join("\n")}\n`, { mode: 0o600 });
}

describe("Mobius logs command", () => {
    it("Given a stopped daemon with logs from both the Runtime and its manager, When the user collects them for a bug report, Then every installation's log is printed with its state-relative path", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeInstallationLog(stateDirectory, "dev.mobius.cli", "worker-lifecycle.log", [
            'Mobius worker lifecycle {"kind":"worker_started","pid":4242,"version":"0.0.272"}',
            'Mobius worker lifecycle {"kind":"worker_exited","pid":4242,"exitCode":137,"signal":"SIGKILL","stderr":"/home/user/secret-path boom"}',
        ]);
        await writeInstallationLog(stateDirectory, "ai.moxt.machine-connector", "daemon.log", [
            'Mobius relay diagnostic {"event":"relay_connection_opened","channelId":"channel-1"}',
        ]);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: stateDirectory };

        const result = await runCli(["logs"], environment, AbortSignal.timeout(30_000));

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("worker-lifecycle.log");
        expect(result.stdout).toContain("daemon.log");
        expect(result.stdout).toContain("worker_started");
        expect(result.stdout).toContain("relay_connection_opened");
        // Paths are reported relative to the state root so a shared report never
        // carries the collector's home directory.
        expect(result.stdout).not.toContain(stateDirectory);
        expect(result.stdout).toContain("installations/dev.mobius.cli/");
        expect(result.stdout).toContain("Review them before sharing");
    }, 60_000);

    it("Given a version-scoped CLI installation, When the user collects logs, Then the versioned Runtime log and the unversioned manager log are both found", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        // A CLI upgrade moves the Runtime's own state under `versions/<version>/`
        // while the manager keeps writing beside the state root, so both shapes
        // have to be found for one report to be complete.
        await writeInstallationLog(join(stateDirectory, "versions", "0.0.272"), "dev.mobius.cli", "daemon.log", [
            'Mobius relay diagnostic {"event":"relay_connection_opened"}',
        ]);
        await writeInstallationLog(stateDirectory, "dev.mobius.cli", "worker-lifecycle.log", [
            'Mobius worker lifecycle {"kind":"worker_exited","exitCode":137,"signal":"SIGKILL"}',
        ]);

        const result = await runCli(
            ["logs", "--state-directory", stateDirectory],
            process.env,
            AbortSignal.timeout(30_000),
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("versions/0.0.272/installations/dev.mobius.cli/");
        expect(result.stdout).toContain("relay_connection_opened");
        expect(result.stdout).toContain("worker_exited");
    }, 60_000);

    it("Given more log lines than the requested tail, When the user collects them, Then the oldest lines are reported as omitted instead of printed", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeInstallationLog(stateDirectory, "dev.mobius.cli", "daemon.log", [
            "oldest-line-should-be-dropped",
            "newest-line-should-be-kept",
        ]);

        const result = await runCli(
            ["logs", "--tail", "1", "--state-directory", stateDirectory],
            process.env,
            AbortSignal.timeout(30_000),
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("newest-line-should-be-kept");
        expect(result.stdout).not.toContain("oldest-line-should-be-dropped");
        expect(result.stdout).toContain("1 earlier line(s) omitted");
    }, 60_000);

    it("Given logs collected as JSON, When the output is piped, Then stdout is machine-parseable and the sharing notice goes to stderr", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeInstallationLog(stateDirectory, "dev.mobius.cli", "daemon.log", [
            '{"event":"relay_connection_opened"}',
        ]);

        const result = await runCli(
            ["logs", "--json", "--state-directory", stateDirectory],
            process.env,
            AbortSignal.timeout(30_000),
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toContain("Review them before sharing");
        const parsed: unknown = JSON.parse(result.stdout);
        expect(parsed).toEqual([
            expect.objectContaining({ lines: ['{"event":"relay_connection_opened"}'], omittedLines: 0 }),
        ]);
    }, 60_000);

    it("Given no daemon has ever run here, When the user collects logs, Then the command reports that nothing was found instead of failing", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-logs-command-"));
        temporaryDirectories.push(directory);

        const result = await runCli(
            ["logs", "--state-directory", join(directory, "unused")],
            process.env,
            AbortSignal.timeout(30_000),
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("No local daemon logs were found.");
    }, 60_000);
});
