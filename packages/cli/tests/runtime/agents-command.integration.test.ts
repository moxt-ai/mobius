import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/** A computer whose PATH offers Node but no Agent, with private Mobius state. */
async function machineWithoutAgents(): Promise<{ readonly environment: NodeJS.ProcessEnv; readonly root: string }> {
    const root = await mkdtemp(join(tmpdir(), "mobius-agents-command-"));
    temporaryDirectories.push(root);
    return {
        root,
        environment: {
            HOME: root,
            MOBIUS_STATE_DIRECTORY: join(root, "state"),
            PATH: dirname(process.execPath),
            TMPDIR: root,
            XDG_STATE_HOME: join(root, "xdg-state"),
        },
    };
}

describe("Mobius agents command", () => {
    it("Given a computer where Pi is not installed, When setup asks for the Agent inventory as a JSON file, Then the file reports Pi's unavailable status and nothing is printed", async () => {
        const { environment, root } = await machineWithoutAgents();
        const outputPath = join(root, "agents.json");
        await writeFile(outputPath, "", { mode: 0o600 });

        const result = await runCli(
            ["agents", `--output-json=${outputPath}`],
            environment,
            AbortSignal.timeout(60_000),
        );

        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe("");
        const inventory: unknown = JSON.parse(await readFile(outputPath, "utf8"));
        expect(inventory).toMatchObject({
            available: [],
            unavailable: expect.arrayContaining([
                expect.objectContaining({ id: "pi", status: "missing_agent", code: "agent_not_found" }),
            ]),
        });
    });

    it("Given the JSON output file does not exist, When the user asks for the Agent inventory, Then the command fails without creating it", async () => {
        const { environment, root } = await machineWithoutAgents();
        const outputPath = join(root, "missing.json");

        const result = await runCli(
            ["agents", `--output-json=${outputPath}`],
            environment,
            AbortSignal.timeout(60_000),
        );

        expect(result.code).not.toBe(0);
        await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
});
