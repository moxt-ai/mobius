import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import packageMetadata from "../../package.json" with { type: "json" };

const temporaryDirectories: string[] = [];
const earlierVersion = "0.0.300";
const installationId = "min_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

async function runCli(
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
    const child = spawn(
        process.execPath,
        [resolve(import.meta.dirname, "../../src/cli/entrypoint.ts"), ...arguments_],
        {
            env: environment,
            signal: AbortSignal.timeout(60_000),
            stdio: ["ignore", "ignore", "pipe"],
        },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve_, reject) => {
        child.once("error", reject);
        child.once("exit", resolve_);
    });
    return { code, stderr };
}

/**
 * A state root whose current data is an earlier CLI version. Its installation keeps a Pi session, and an Agent shell
 * once ran Mobius with that installation as its root, leaving a nested root's entries and npm release links there.
 */
async function rootWithNestedInstallation() {
    const home = await mkdtemp(join(tmpdir(), "mobius-version-inheritance-"));
    temporaryDirectories.push(home);
    const root = join(home, "state");
    const application = join(root, "versions", earlierVersion, "installations", "dev.mobius.cli");
    const installation = join(application, installationId);
    const session = join(installation, "agents", "pi", "sessions", "workspace-hash", "session.jsonl");
    const releaseBin = join(installation, "npm", "0.0.309", "node_modules", ".bin");
    await Promise.all([
        mkdir(dirname(session), { recursive: true }),
        mkdir(releaseBin, { recursive: true }),
        mkdir(join(installation, "versions", "0.0.309", "installations"), { recursive: true }),
        mkdir(join(installation, "installations", "dev.mobius.cli"), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(join(root, "current-data.txt"), `versions/${earlierVersion}\n`),
        writeFile(join(application, "current.json"), JSON.stringify({ installationId, version: 1 })),
        writeFile(session, '{"type":"session"}\n'),
        writeFile(join(installation, "current-data.txt"), "versions/0.0.309\n"),
        symlink("../@moxt-ai/mobius/dist/cli.js", join(releaseBin, "mobius")),
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
    it("Given an earlier version's installation that an Agent shell once used as a nested state root, When a newer CLI first runs, Then it starts, keeps the installation's data, and leaves the nested root's entries behind", async () => {
        const { environment, inherited } = await rootWithNestedInstallation();

        const listed = await runCli(["pair", "list"], environment);

        expect(listed.code, listed.stderr).toBe(0);
        expect(
            await readFile(join(inherited, "agents", "pi", "sessions", "workspace-hash", "session.jsonl"), "utf8"),
        ).toBe('{"type":"session"}\n');
        expect((await readdir(inherited)).sort()).toEqual(["agents"]);
    });

    it("Given a symbolic link inside an earlier version's installation data, When a newer CLI first runs, Then inheritance still refuses it", async () => {
        const { environment, installation } = await rootWithNestedInstallation();
        await symlink("/etc/hostname", join(installation, "agents", "pi", "linked"));

        const listed = await runCli(["pair", "list"], environment);

        expect(listed.code).toBe(1);
        expect(listed.stderr).toContain("The inherited data contains a symbolic link");
    });
});
