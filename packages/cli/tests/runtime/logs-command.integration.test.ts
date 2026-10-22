import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    // @no-uc: Technical regression; a bug report must collect logs from every installation, not just the active one.
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

    // @no-uc: Technical regression; a CLI upgrade relocates Runtime state, and both installations shapes must still be found.
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

    // @no-uc: Technical regression; bounded log tailing must report what it dropped rather than hide it.
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

    // @no-uc: Technical regression; machine-readable log export must keep stdout parseable for evidence pipelines.
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
        expect(parsed).toEqual({
            entries: [expect.objectContaining({ lines: ['{"event":"relay_connection_opened"}'], omittedLines: 0 })],
            unreadable: [],
        });
    }, 60_000);

    // @no-uc: Technical regression; a forensic log export must not mutate the files it reads.
    it("Given logs with permissions the daemon did not tighten, When the user collects them, Then collection is read-only and the file modes are unchanged", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeInstallationLog(stateDirectory, "dev.mobius.cli", "daemon.log", [
            '{"event":"relay_connection_opened"}',
        ]);
        const logPath = join(
            stateDirectory,
            "installations",
            "dev.mobius.cli",
            "min_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "logs",
            "daemon.log",
        );
        const directoryPath = dirname(logPath);
        // Widen both deliberately: `validateLocalPath(path, ..., privateAccess: true)`
        // repairs modes with chmod, which would silently hide this difference.
        await chmod(logPath, 0o644);
        await chmod(directoryPath, 0o755);

        const result = await runCli(
            ["logs", "--state-directory", stateDirectory],
            process.env,
            AbortSignal.timeout(30_000),
        );

        expect(result.code).toBe(0);
        expect(result.stdout).toContain("relay_connection_opened");
        expect((await stat(logPath)).mode & 0o777).toBe(0o644);
        expect((await stat(directoryPath)).mode & 0o777).toBe(0o755);
    }, 60_000);

    // @no-uc: Technical regression; unreadable evidence must not be reported as absent.
    it("Given a log the collector cannot read, When the user collects logs, Then the report names the missing file and fails instead of claiming no logs exist", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeInstallationLog(stateDirectory, "dev.mobius.cli", "daemon.log", [
            '{"event":"relay_connection_opened"}',
        ]);
        const logPath = join(
            stateDirectory,
            "installations",
            "dev.mobius.cli",
            "min_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "logs",
            "daemon.log",
        );
        // Simulates the read-only mount or failing-disk case the export has to
        // survive: the file is present but this user cannot read it.
        await chmod(logPath, 0o000);
        try {
            const result = await runCli(
                ["logs", "--state-directory", stateDirectory],
                process.env,
                AbortSignal.timeout(30_000),
            );

            expect(result.code).toBe(1);
            expect(result.stdout).toContain("The local daemon logs could not be read.");
            expect(result.stdout).not.toContain("No local daemon logs were found.");
            expect(result.stderr).toContain("could not be read and are missing from this report");
            expect(result.stderr).toContain("daemon.log");

            const reported = await runCli(
                ["logs", "--json", "--state-directory", stateDirectory],
                process.env,
                AbortSignal.timeout(30_000),
            );
            // JSON mode is the machine-consumable path, so it has to carry the same
            // failure status; a collector keying on the exit code cannot be fooled
            // by the format flag.
            expect(reported.code).toBe(1);
            const parsed = JSON.parse(reported.stdout) as {
                readonly entries: unknown[];
                readonly unreadable: string[];
            };
            expect(parsed.entries).toEqual([]);
            expect(parsed.unreadable).toEqual([
                "installations/dev.mobius.cli/min_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logs/daemon.log",
            ]);
        } finally {
            await chmod(logPath, 0o600);
        }
    }, 60_000);

    // @no-uc: Technical regression; an unlistable log directory must count as a collection failure.
    it("Given a log directory this user cannot list, When the user collects logs, Then the directory is reported unreadable instead of being treated as holding no logs", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-logs-command-"));
        temporaryDirectories.push(directory);
        const stateDirectory = join(directory, "state");
        await writeInstallationLog(stateDirectory, "dev.mobius.cli", "daemon.log", [
            '{"event":"relay_connection_opened"}',
        ]);
        // The logs directory exists and holds a readable file, but cannot be
        // enumerated: an owner-writable, not owner-readable mode (0o300). Treating
        // this as "no logs here" is what hid the evidence before.
        const logsDirectory = join(
            stateDirectory,
            "installations",
            "dev.mobius.cli",
            "min_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "logs",
        );
        await chmod(logsDirectory, 0o300);
        try {
            const result = await runCli(
                ["logs", "--state-directory", stateDirectory],
                process.env,
                AbortSignal.timeout(30_000),
            );

            expect(result.code).toBe(1);
            expect(result.stdout).toContain("The local daemon logs could not be read.");
            expect(result.stdout).not.toContain("No local daemon logs were found.");
            expect(result.stderr).toContain("installations/dev.mobius.cli/min_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logs");
        } finally {
            await chmod(logsDirectory, 0o700);
        }
    }, 60_000);

    // @no-uc: Technical regression; a clean machine must report no logs distinctly from an unreadable one.
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
