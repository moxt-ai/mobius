import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import packageMetadata from "../../package.json" with { type: "json" };
import { installWorkspaceDaemonRelease, workspaceDaemonEnvironment } from "../support/installed-daemon-release.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
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

/** A state root that `mobius pair list` has opened, and the installation data directory it created inside it. */
async function openedStateRoot(): Promise<{
    readonly root: string;
    readonly installation: string;
    readonly home: string;
}> {
    const home = await mkdtemp(join(tmpdir(), "mobius-state-root-"));
    temporaryDirectories.push(home);
    const root = join(home, "state");
    const listed = await runCli(["pair", "list"], environment(home, root));
    expect(listed.code, listed.stderr).toBe(0);
    const application = join(root, "versions", packageMetadata.version, "installations", "dev.mobius.cli");
    const pointer: unknown = JSON.parse(await readFile(join(application, "current.json"), "utf8"));
    const installationId =
        typeof pointer === "object" && pointer !== null && "installationId" in pointer ? pointer.installationId : null;
    if (typeof installationId !== "string") {
        throw new Error("The opened state root has no current installation");
    }
    return { root, installation: join(application, installationId), home };
}

function environment(home: string, stateDirectory: string): NodeJS.ProcessEnv {
    return { HOME: home, MOBIUS_STATE_DIRECTORY: stateDirectory, PATH: dirname(process.execPath), TMPDIR: home };
}

describe("Mobius state root", () => {
    it.each(["pair list", "start"])(
        "Given the version-data directory is a symlink, When the user runs %s, Then the CLI or Worker refuses without creating connection state in the link target",
        async (command) => {
            const home = await mkdtemp(join(tmpdir(), "mobius-version-container-"));
            temporaryDirectories.push(home);
            const root = join(home, "state");
            const target = join(home, "redirected");
            await mkdir(join(root, "versions"), { recursive: true, mode: 0o700 });
            await mkdir(target, { mode: 0o700 });
            await symlink(
                target,
                join(root, "versions", packageMetadata.version),
                process.platform === "win32" ? "junction" : "dir",
            );

            const env = environment(home, root);
            if (command === "start") {
                await installWorkspaceDaemonRelease(root);
                // Startup must validate the container even when no inheritance is needed.
                await writeFile(join(root, "current-data.txt"), `versions/${packageMetadata.version}\n`, {
                    mode: 0o600,
                });
            }
            try {
                const result = await runCli(command === "start" ? ["start"] : ["pair", "list"], env);

                expect(result.code).not.toBe(0);
                expect(await readdir(target)).toEqual([]);
            } finally {
                if (command === "start") {
                    await runCli(["quit"], env);
                }
            }
        },
    );

    it.skipIf(process.platform === "win32")(
        "Given a user-owned version-data directory allows other users to write, When the user lists pairings, Then the CLI makes the container private before initializing state",
        async () => {
            const home = await mkdtemp(join(tmpdir(), "mobius-version-container-"));
            temporaryDirectories.push(home);
            const root = join(home, "state");
            const versionDirectory = join(root, "versions", packageMetadata.version);
            await mkdir(versionDirectory, { recursive: true });
            await chmod(versionDirectory, 0o777);

            const listed = await runCli(["pair", "list"], environment(home, root));

            expect(listed.code, listed.stderr).toBe(0);
            expect((await stat(versionDirectory)).mode & 0o777).toBe(0o700);
        },
    );

    it("Given an Agent environment whose MOBIUS_STATE_DIRECTORY names an installation's data, When Mobius runs there, Then it refuses with a configuration error that names the owning root and creates nothing inside that data", async () => {
        const { root, installation, home } = await openedStateRoot();
        const before = await readdir(installation);

        const listed = await runCli(["pair", "list"], environment(home, installation));

        expect(listed.code).toBe(78);
        expect(listed.stderr).toContain(`MOBIUS_STATE_DIRECTORY=${root}`);
        expect(await readdir(installation)).toEqual(before);
    });

    it("Given an installation's data where an earlier nested Mobius only left control files, When Mobius runs there, Then it still refuses instead of treating it as a root", async () => {
        const { root, installation, home } = await openedStateRoot();
        await mkdir(join(installation, "installations", "dev.mobius.cli"), { recursive: true, mode: 0o700 });

        const listed = await runCli(["pair", "list"], environment(home, installation));

        expect(listed.code).toBe(78);
        expect(listed.stderr).toContain(`MOBIUS_STATE_DIRECTORY=${root}`);
    });

    it("Given an installation's data that was already initialized as a state root, When Mobius runs with it, Then it keeps working as that root", async () => {
        const { installation, home } = await openedStateRoot();
        // A daemon that ran with this directory as its root recorded its current version data there.
        await mkdir(join(installation, "versions", packageMetadata.version), { recursive: true, mode: 0o700 });
        await writeFile(join(installation, "current-data.txt"), `versions/${packageMetadata.version}\n`, {
            mode: 0o600,
        });

        const listed = await runCli(["pair", "list"], environment(home, installation));

        expect(listed.code, listed.stderr).toBe(0);
    });
});
