import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatAgentDiagnostics } from "../../src/agent-catalog/agent-diagnostics.ts";
import {
    AvailableAgent,
    CodexAgentSpecification,
    DeepSeekHarnessAgentSpecification,
    discoverLocalAgentInventory,
    OhMyPiAgentSpecification,
    OpenCodeAgentSpecification,
    PiAgentSpecification,
    resolveAgentExecutable,
} from "../../src/agent-catalog/discover-local-agents.ts";
import {
    OPENCODE_MANAGED_VERSION,
    openCodeManagedArchive,
} from "../../src/agent-installation/opencode-managed-release.ts";

const fakeAgentPath = fileURLToPath(new URL("../support/acp/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

describe("local Agent discovery", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("Given an installed OpenCode below the supported version, When verbose discovery runs, Then the CLI reports both versions and detection time", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-old-opencode-"));
        const executable = join(temporaryDirectory, "opencode");
        const monotonicTimes = [100, 125];
        try {
            await writeFile(executable, executableSource('process.stdout.write("1.18.28\\n");'), { mode: 0o700 });
            await chmod(executable, 0o700);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: { PATH: temporaryDirectory },
                monotonicTimeMilliseconds: () => monotonicTimes.shift() ?? 125,
                signal: new AbortController().signal,
                specifications: [new OpenCodeAgentSpecification()],
            });

            expect(inventory.available).toEqual([]);
            expect(inventory.unavailable).toEqual([
                expect.objectContaining({
                    agent: expect.objectContaining({ agentVersion: "1.18.28" }),
                    code: "agent_version_unsupported",
                    minimumSupportedVersion: OPENCODE_MANAGED_VERSION,
                    status: "unsupported_version",
                }),
            ]);
            expect(JSON.parse(formatAgentDiagnostics(inventory, true, true))).toEqual({
                available: [],
                unavailable: [
                    {
                        agentVersion: "1.18.28",
                        code: "agent_version_unsupported",
                        detectionMilliseconds: 25,
                        id: "opencode",
                        label: "OpenCode",
                        message: `Agent version 1.18.28 is below the minimum supported version ${OPENCODE_MANAGED_VERSION}`,
                        minimumSupportedVersion: OPENCODE_MANAGED_VERSION,
                        recoveryCommand: "",
                        status: "unsupported_version",
                    },
                ],
            });
            expect(formatAgentDiagnostics(inventory, false, true)).toContain("detection=25ms");
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given Oh My Pi is installed, When local discovery runs, Then its native ACP harness is available", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-oh-my-pi-"));
        const ompPath = join(temporaryDirectory, "omp");
        try {
            await writeFile(
                ompPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("18.2.7\\n");
} else {
  process.argv.push("--agent-name", "Oh My Pi");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            );
            await chmod(ompPath, 0o700);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: { PATH: temporaryDirectory },
                signal: new AbortController().signal,
                specifications: [new OhMyPiAgentSpecification()],
            });

            expect(inventory.unavailable).toEqual([]);
            expect(inventory.available).toHaveLength(1);
            const discovered = inventory.available[0];
            if (!(discovered instanceof AvailableAgent)) {
                throw new Error("Oh My Pi was not discovered");
            }
            expect(discovered.agent).toMatchObject({
                command: await realpath(ompPath),
                id: "oh-my-pi",
                label: "Oh My Pi",
            });
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given an untrusted relative DSH_HOME, When DeepSeek Harness discovery runs, Then Mobius refuses to launch the ACP profile", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-deepseek-home-"));
        const dshPath = join(temporaryDirectory, "dsh");
        try {
            await writeFile(
                dshPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.1.5-rc.2\\n");
} else {
  process.exit(80);
}
`),
                { mode: 0o700 },
            );
            await chmod(dshPath, 0o700);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: { DSH_HOME: "relative-home", PATH: temporaryDirectory },
                signal: new AbortController().signal,
                specifications: [new DeepSeekHarnessAgentSpecification()],
            });

            expect(inventory.available).toEqual([]);
            expect(inventory.unavailable).toHaveLength(1);
            expect(inventory.unavailable[0]).toMatchObject({
                code: "agent_environment_invalid",
                status: "probe_failed",
            });
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it.runIf(
        (process.platform === "darwin" || process.platform === "linux") &&
            (process.arch === "arm64" || process.arch === "x64"),
    )(
        "Given an incompatible PATH OpenCode and a verified managed OpenCode, When discovery falls back, Then one managed executable owns both direct ACP identities",
        async () => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-opencode-fallback-"));
            const externalDirectory = join(temporaryDirectory, "external");
            const stateDirectory = join(temporaryDirectory, "state");
            const externalPath = join(externalDirectory, "opencode");
            const managedRoot = join(stateDirectory, "agents", "opencode", OPENCODE_MANAGED_VERSION);
            const managedPath = join(managedRoot, "bin", "opencode");
            try {
                await mkdir(externalDirectory, { mode: 0o700 });
                await mkdir(join(managedRoot, "bin"), { mode: 0o700, recursive: true });
                await writeFile(
                    externalPath,
                    executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("1.18.29\\n");
} else {
  process.argv.push("--agent-name", "OpenCode", "--agent-version", "1.18.29", "--no-load-session");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                    { mode: 0o700 },
                );
                const managedSource = executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("1.18.29\\n");
} else {
  process.argv.push("--agent-name", "OpenCode", "--agent-version", "1.18.29");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`);
                await writeFile(managedPath, managedSource, { mode: 0o700 });
                await Promise.all([chmod(externalPath, 0o700), chmod(managedPath, 0o700)]);
                const definition = openCodeManagedArchive(process.platform, process.arch);
                await writeFile(
                    join(managedRoot, "archive.json"),
                    `${JSON.stringify({
                        archiveSha256: definition.archiveSha256,
                        archiveUrl: definition.archiveUrl.toString(),
                        executableSha256: createHash("sha256").update(managedSource).digest("hex"),
                        version: definition.version,
                    })}\n`,
                    { mode: 0o600 },
                );

                const inventory = await discoverLocalAgentInventory({
                    defaultWorkspace: temporaryDirectory,
                    environment: {
                        MOBIUS_STATE_DIRECTORY: stateDirectory,
                        PATH: externalDirectory,
                    },
                    signal: new AbortController().signal,
                    specifications: [new OpenCodeAgentSpecification()],
                });

                expect(inventory.unavailable).toEqual([]);
                expect(inventory.available).toHaveLength(1);
                const discovered = inventory.available[0];
                if (!(discovered instanceof AvailableAgent)) {
                    throw new Error("Managed OpenCode was not discovered");
                }
                if (discovered.agent.kind !== "acp-adapter-process") {
                    throw new Error("Managed OpenCode did not use its adapter topology");
                }
                const canonicalManagedPath = await realpath(managedPath);
                expect(discovered.agent.command).toBe(canonicalManagedPath);
                expect(discovered.agent.adapterIdentity.realPath).toBe(canonicalManagedPath);
                expect(discovered.agent.agentIdentity.realPath).toBe(canonicalManagedPath);
            } finally {
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );
    it("Given a verified Pi executable exists without pi-acp, When discovery runs, Then Pi is detected with its details but its integration is not ready", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-pi-missing-adapter-"));
        const piPath = join(temporaryDirectory, "pi");
        try {
            await writeFile(
                piPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.85.0\\n");
}
`),
                { mode: 0o700 },
            );
            await chmod(piPath, 0o700);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: {
                    MOBIUS_STATE_DIRECTORY: temporaryDirectory,
                    PATH: temporaryDirectory,
                },
                signal: new AbortController().signal,
                specifications: [new PiAgentSpecification()],
            });

            expect(inventory.available).toEqual([]);
            expect(inventory.unavailable).toHaveLength(1);
            expect(inventory.unavailable[0]).toMatchObject({
                code: "adapter_not_found",
                status: "missing_adapter",
            });
            expect(inventory.installable).toEqual([
                expect.objectContaining({
                    agentPath: piPath,
                    agentVersion: "0.85.0",
                    id: "pi",
                    label: "Pi",
                    status: "integration_not_installed",
                }),
            ]);
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given Pi and pi-acp are verified but Pi needs local authentication, When discovery runs, Then Mobius reports authentication-required with only the terminal login entrypoint", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-pi-authentication-"));
        const piPath = join(temporaryDirectory, "pi");
        const adapterPath = join(temporaryDirectory, "pi-acp");
        try {
            await writeFile(
                piPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.85.0\\n");
} else {
  process.argv.push("--agent-name", "Pi", "--authentication-required");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            );
            await writeFile(
                adapterPath,
                executableSource(`
import { spawn } from "node:child_process";
const executable = process.env.PI_ACP_PI_COMMAND;
if (executable === undefined) process.exit(91);
const child = spawn(executable, ["--mode", "rpc"], {
  env: process.env,
  stdio: "inherit",
});
child.once("error", () => process.exit(92));
child.once("exit", (code) => process.exit(code ?? 93));
`),
                { mode: 0o700 },
            );
            await Promise.all([chmod(piPath, 0o700), chmod(adapterPath, 0o700)]);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: {
                    MOBIUS_STATE_DIRECTORY: temporaryDirectory,
                    PATH: temporaryDirectory,
                },
                signal: new AbortController().signal,
                specifications: [new PiAgentSpecification()],
            });

            expect(inventory.available).toEqual([]);
            expect(inventory.installable).toEqual([
                expect.objectContaining({
                    agentPath: piPath,
                    agentVersion: "0.85.0",
                    id: "pi",
                    label: "Pi",
                    status: "integration_not_installed",
                }),
            ]);
            expect(inventory.unavailable).toHaveLength(1);
            expect(inventory.unavailable[0]).toMatchObject({
                code: "authentication_required",
                status: "authentication_required",
            });
            expect(JSON.parse(formatAgentDiagnostics(inventory, true))).toEqual({
                available: [],
                unavailable: [
                    {
                        code: "authentication_required",
                        id: "pi",
                        label: "Pi",
                        message: "Agent authentication is required",
                        recoveryCommand: "pi-acp --terminal-login",
                        status: "authentication_required",
                    },
                ],
            });
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given PATH contains an Agent in the default working directory, When the paired machine discovers Agents, Then the working directory does not exclude that executable", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "mobius-path-boundary-"));
        const codexPath = join(workspace, "codex");
        try {
            await writeFile(codexPath, executableSource('process.stdout.write("codex 0.153.0\\n");'), { mode: 0o700 });
            await chmod(codexPath, 0o700);
            const specification = new CodexAgentSpecification();

            await expect(
                resolveAgentExecutable(specification, {
                    defaultWorkspace: workspace,
                    environment: { PATH: workspace },
                    signal: new AbortController().signal,
                }),
            ).resolves.toMatchObject({ path: await realpath(codexPath) });
            await expect(
                resolveAgentExecutable(specification, {
                    defaultWorkspace: workspace,
                    environment: {
                        MOBIUS_CODEX_PATH: codexPath,
                        PATH: workspace,
                    },
                    signal: new AbortController().signal,
                }),
            ).resolves.toMatchObject({ path: await realpath(codexPath) });
        } finally {
            await rm(workspace, { force: true, recursive: true });
        }
    });
});
