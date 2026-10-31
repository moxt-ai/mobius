import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
        env: environment,
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

// Daemons and CLI commands share the data selected by the existing on-disk pointer.
async function startNewerDaemon(environment: Readonly<NodeJS.ProcessEnv>) {
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
    const environment = { HOME: home, MOBIUS_STATE_DIRECTORY: root, PATH: dirname(process.execPath), TMPDIR: home };
    return { environment, installation, root };
}

describe("Mobius version data inheritance", () => {
    it("Given an earlier version's current data, When a newer daemon first starts, Then it keeps the same authoritative data without a version copy", async () => {
        const { environment, installation, root } = await rootWithEarlierInstallation();

        const started = await startNewerDaemon(environment);

        expect(started.code, started.stderr).toBe(0);
        expect(
            await readFile(join(installation, "agents", "pi", "sessions", "workspace-hash", "session.jsonl"), "utf8"),
        ).toBe('{"type":"session"}\n');
        expect(await readFile(join(root, "current-data.txt"), "utf8")).toBe(`versions/${earlierVersion}\n`);
        expect(await readdir(join(root, "versions"))).toEqual([earlierVersion]);
    });

    it("Given a workspace containing package executable symlinks, When a newer daemon starts, Then the workspace stays usable in place", async () => {
        const { environment, installation } = await rootWithEarlierInstallation();
        const workspace = join(installation, "workspace");
        const bin = join(workspace, "node_modules", ".bin");
        await mkdir(bin, { recursive: true });
        await writeFile(join(workspace, "tool.js"), "workspace tool");
        await symlink("../../tool.js", join(bin, "tool"));

        const started = await startNewerDaemon(environment);

        expect(started.code, started.stderr).toBe(0);
        expect(await readFile(join(bin, "tool"), "utf8")).toBe("workspace tool");
    });

    it("Given a pairing copied by earlier releases, When it is removed, Then its credential disappears from every saved copy and user files remain", async () => {
        const { environment, installation, root } = await rootWithEarlierInstallation();
        const connectionId = `mcn_${"b".repeat(32)}`;
        const connections = join(installation, "connections");
        await mkdir(connections, { recursive: true });
        await writeFile(
            join(connections, `${connectionId}.json`),
            JSON.stringify({
                activation: "stopped",
                appId: "app_saved",
                channelId: "channel_saved",
                connectionId,
                defaultWorkspace: installation,
                installationId,
                kind: "verified",
                pairingId: "",
                relayOrigin: "http://127.0.0.1:1",
                runtimeCredential: "a".repeat(43),
                runtimeId: "runtime_saved",
                version: 6,
            }),
        );
        const historical = join(root, "versions", "0.0.299");
        await cp(join(root, "versions", earlierVersion), historical, { recursive: true });
        expect((await runCli(["pair", "list"], environment)).stdout).toContain(connectionId);

        const removed = await runCli(["pair", "remove", "--connection", connectionId], environment);

        expect(removed.code, removed.stderr).toBe(0);
        expect((await runCli(["pair", "list"], environment)).stdout).not.toContain(connectionId);
        for (const version of [earlierVersion, "0.0.299"]) {
            const saved = join(root, "versions", version, "installations", "dev.mobius.cli", installationId);
            await expect(readFile(join(saved, "connections", `${connectionId}.json`))).rejects.toMatchObject({
                code: "ENOENT",
            });
            expect(
                await readFile(join(saved, "agents", "pi", "sessions", "workspace-hash", "session.jsonl"), "utf8"),
            ).toBe('{"type":"session"}\n');
        }
    });
});
