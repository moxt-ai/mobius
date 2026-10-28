import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { executableLaunch } from "../../src/engine/util/process/executable.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test.runIf(process.platform === "win32")(
    "Given real Codex is installed behind an npm Windows shim, When the user lists Agents from a workspace containing shell characters, Then Codex is ready without a command shell",
    async () => {
        await using provider = await FakeOpenAiProvider.start("mobius-test-model", "WINDOWS_DISCOVERY_REPLY");
        await using codex = await CodexFixture.create(provider);
        const directory = await mkdtemp(join(tmpdir(), "mobius-windows-codex-"));
        const workspace = join(directory, "workspace & ' spaces");
        const bin = join(directory, "npm bin & spaces");
        await Promise.all([workspace, bin].map((path) => mkdir(path)));
        const launcher = join(bin, "codex.mjs");
        const shim = join(bin, "codex.cmd");
        const launch = executableLaunch(codex.executable, []);
        try {
            await writeFile(
                launcher,
                `import {spawn} from 'node:child_process';
const child = spawn(${JSON.stringify(launch.command)}, [...${JSON.stringify(launch.arguments)}, ...process.argv.slice(2)], {stdio:'inherit', windowsHide:true});
child.once('error', () => process.exit(1));
child.once('exit', code => process.exit(code ?? 1));\n`,
            );
            await writeFile(
                shim,
                '@ECHO off\r\nSET dp0=%~dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\codex.mjs" %*\r\n',
            );
            const environment = Object.fromEntries(
                Object.entries({ ...process.env, ...codex.environment }).filter(
                    ([key]) => key !== "MOBIUS_CODEX_PATH" && key.toUpperCase() !== "PATH",
                ),
            );
            const result = await promisify(execFile)(
                process.execPath,
                [resolve(import.meta.dirname, "../../src/cli/entrypoint.ts"), "agents", "--json"],
                {
                    cwd: workspace,
                    env: {
                        ...environment,
                        Path: `${bin};${process.env["PATH"] ?? ""}`,
                        MOBIUS_STATE_DIRECTORY: join(directory, "state"),
                    },
                    signal: AbortSignal.timeout(30000),
                    timeout: 30000,
                    windowsHide: true,
                    maxBuffer: 1024 * 1024,
                },
            );
            const inventory: unknown = JSON.parse(result.stdout);
            expect(inventory).toMatchObject({
                available: expect.arrayContaining([expect.objectContaining({ id: "codex" })]),
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
