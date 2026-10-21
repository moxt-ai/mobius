import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import cliPackage from "../../package.json" with { type: "json" };

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

describe("Mobius version command", () => {
    it("Given no running daemon, When the user asks for the version, Then the CLI reports its own version and that no daemon is running", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-version-command-"));
        temporaryDirectories.push(directory);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: join(directory, "state") };
        const signal = AbortSignal.timeout(30_000);
        const expected = `CLI: ${cliPackage.version}\nDaemon: not running\n`;
        expect((await runCli(["--version"], environment, signal)).stdout).toBe(expected);
        expect((await runCli(["-v"], environment, signal)).stdout).toBe(expected);
    }, 60_000);

    it("Given a running daemon, When the user asks for the version, Then the CLI reports both the CLI and daemon versions", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-version-command-"));
        temporaryDirectories.push(directory);
        const environment = { ...process.env, MOBIUS_STATE_DIRECTORY: join(directory, "state") };
        const signal = AbortSignal.timeout(60_000);
        try {
            const started = await runCli(["start"], environment, signal);
            expect(started.code).toBe(0);

            const reported = await runCli(["--version"], environment, signal);
            expect(reported.code).toBe(0);
            expect(reported.stderr).toBe("");
            expect(reported.stdout).toBe(`CLI: ${cliPackage.version}\nDaemon: ${cliPackage.version}\n`);
        } finally {
            await runCli(["quit"], environment, AbortSignal.timeout(10_000)).catch(() => undefined);
        }
    }, 90_000);
});
