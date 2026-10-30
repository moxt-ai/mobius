import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import packageMetadata from "../../package.json" with { type: "json" };
import { installWorkspaceDaemonRelease, workspaceDaemonEnvironment } from "../support/installed-daemon-release.ts";

const temporaryDirectories: string[] = [];
const runningRoots: Readonly<NodeJS.ProcessEnv>[] = [];
const earlierVersion = "0.0.300";
const installationId = "min_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

afterEach(async () => {
    for (const environment of runningRoots.splice(0)) {
        await runCli(["quit"], environment);
    }
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

async function runCli(
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../dist/cli.js"), ...arguments_], {
        env: workspaceDaemonEnvironment(environment),
        signal: AbortSignal.timeout(60_000),
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve_, reject) => {
        child.once("error", reject);
        child.once("exit", resolve_);
    });
    return { code, stderr, stdout };
}

// The daemon of a newer version inherits the current data when it starts; CLI commands only use the current data.
async function startNewerDaemon(environment: Readonly<NodeJS.ProcessEnv>) {
    const root = environment["MOBIUS_STATE_DIRECTORY"] ?? "";
    await installWorkspaceDaemonRelease(root);
    runningRoots.push(environment);
    return await runCli(["start"], environment);
}

/** A state root whose current data is an earlier CLI version. Its installation keeps a Pi session. */
async function rootWithEarlierInstallation() {
    const home = await mkdtemp(join(tmpdir(), "mobius-version-inheritance-"));
    temporaryDirectories.push(home);
    const root = join(home, "state");
    const application = join(root, "versions", earlierVersion, "installations", "dev.mobius.cli");
    const installation = join(application, installationId);
    const session = join(installation, "agents", "pi", "sessions", "workspace-hash", "session.jsonl");
    await mkdir(dirname(session), { recursive: true });
    await Promise.all([
        writeFile(join(root, "current-data.txt"), `versions/${earlierVersion}\n`),
        writeFile(join(application, "current.json"), JSON.stringify({ installationId, version: 1 })),
        writeFile(session, '{"type":"session"}\n'),
    ]);
    const inherited = join(
        root,
        "versions",
        packageMetadata.version,
        "installations",
        "dev.mobius.cli",
        installationId,
    );
    const environment = { HOME: home, MOBIUS_STATE_DIRECTORY: root, PATH: dirname(process.execPath), TMPDIR: home };
    return { environment, installation, inherited };
}

describe("Mobius version data inheritance", () => {
    it("Given an earlier version's current data, When a newer daemon first starts, Then it starts with the installation's data", async () => {
        const { environment, inherited } = await rootWithEarlierInstallation();

        const started = await startNewerDaemon(environment);

        expect(started.code, started.stderr).toBe(0);
        expect(
            await readFile(join(inherited, "agents", "pi", "sessions", "workspace-hash", "session.jsonl"), "utf8"),
        ).toBe('{"type":"session"}\n');
    });

    it("Given a symbolic link inside an earlier version's installation data, When a newer daemon first starts, Then inheritance still refuses it", async () => {
        const { environment, installation } = await rootWithEarlierInstallation();
        await symlink("/etc/hostname", join(installation, "agents", "pi", "linked"));

        const started = await startNewerDaemon(environment);

        expect(started.code).toBe(1);
        expect((await runCli(["logs"], environment)).stdout).toContain("The inherited data contains a symbolic link");
    });
});
