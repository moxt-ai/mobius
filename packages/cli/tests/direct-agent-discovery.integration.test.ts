import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../src/acp/session-manager.ts";
import {
    AvailableAgent,
    DeepSeekHarnessAgentSpecification,
    discoverLocalAgentInventory,
    OpenCodeAgentSpecification,
} from "../src/agent-catalog/discover-local-agents.ts";
import {
    OPENCODE_MANAGED_VERSION,
    openCodeManagedArchive,
} from "../src/agent-installation/opencode-managed-release.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

describe("direct ACP Agent discovery", () => {
    it("Given a verified local DeepSeek Harness installation, When Mobius discovers Agents, Then it uses the canonical local launch and publishes only its verified ACP capabilities", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-deepseek-discovery-"));
        const dshPath = join(temporaryDirectory, "dsh");
        const homeDirectory = join(temporaryDirectory, "dsh-home");
        const homeLink = join(temporaryDirectory, "selected-dsh-home");
        const manager = new AcpSessionManager();
        try {
            await mkdir(homeDirectory, { mode: 0o700 });
            await symlink(homeDirectory, homeLink);
            const canonicalHome = await realpath(homeDirectory);
            await writeFile(
                dshPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.1.2-rc.1\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--profile", "acp"])) process.exit(81);
  if (process.env.DSH_PERMISSION_MODE !== "workspace-write") process.exit(82);
  if (process.env.DSH_HOME !== ${JSON.stringify(canonicalHome)}) process.exit(83);
  process.argv.push(
    "--agent-name", "DeepSeek Harness",
    "--agent-version", "0.0.1",
    "--announce-config-while-creating",
    "--http-mcp",
    "--no-load-session",
    "--no-additional-directories",
    "--no-delete-session",
    "--no-embedded-context",
    "--no-fork-session",
    "--no-image-prompt"
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            );
            await chmod(dshPath, 0o700);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: {
                    DSH_HOME: homeLink,
                    DSH_PERMISSION_MODE: "danger-full-access",
                    PATH: temporaryDirectory,
                },
                signal: new AbortController().signal,
                specifications: [new DeepSeekHarnessAgentSpecification()],
            });

            expect(inventory.unavailable).toEqual([]);
            expect(inventory.available).toHaveLength(1);
            const discovered = inventory.available[0];
            if (!(discovered instanceof AvailableAgent)) {
                throw new Error("DeepSeek Harness was not discovered");
            }
            const canonicalExecutable = await realpath(dshPath);
            expect(discovered.agent.command).toBe(canonicalExecutable);
            expect(discovered.agent.agentIdentity.realPath).toBe(canonicalExecutable);
            expect(discovered.agent.adapterIdentity.realPath).toBe(canonicalExecutable);
            expect(discovered.agent.arguments).toEqual(["--profile", "acp"]);
            expect(discovered.agent.environment).toEqual({
                DSH_HOME: canonicalHome,
                DSH_PERMISSION_MODE: "workspace-write",
            });
            expect(discovered.agent.agentVersion).toBe("0.1.2-rc.1");
            expect(discovered.agent.adapterVersion).toBe("0.1.2-rc.1");
            expect(discovered.agent.capabilities).toEqual({
                additionalDirectories: false,
                audioPrompt: false,
                closeSession: true,
                deleteSession: false,
                embeddedContextPrompt: false,
                imagePrompt: false,
                listSessions: true,
                loadSession: false,
                resumeSession: true,
                unstableForkSession: false,
            });

            const prepared = await manager.prepareSession({
                additionalDirectories: [],
                agent: discovered.agent,
                cwd: temporaryDirectory,
                sessionId: "deepseek-session",
                signal: new AbortController().signal,
            });
            expect(prepared.agentVersion).toBe("0.1.2-rc.1");
            expect(prepared.configOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ category: "model", id: "model" }),
                    expect.objectContaining({
                        category: "thought_level",
                        id: "reasoning_effort",
                    }),
                ]),
            );

            const chunks: string[] = [];
            await manager.runPrompt({
                additionalDirectories: [],
                agent: discovered.agent,
                commandId: "deepseek-command",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    chunks.push(text);
                    return Promise.resolve();
                },
                prompt: "use the verified DeepSeek Harness executable",
                resources: [],
                sessionId: "deepseek-session",
                signal: new AbortController().signal,
            });
            expect(chunks.join("")).toBe("DeepSeek Harness turn 1: use the verified DeepSeek Harness executable");
        } finally {
            await manager.close();
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
  process.stdout.write("0.1.2-rc.1\\n");
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

    it("Given a verified local OpenCode installation, When Mobius discovers Agents, Then it launches the same canonical executable through opencode acp with auto-update disabled", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-opencode-discovery-"));
        const openCodePath = join(temporaryDirectory, "opencode");
        const manager = new AcpSessionManager();
        try {
            await writeFile(
                openCodePath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("1.18.29\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["acp"])) process.exit(81);
  if (process.env.OPENCODE_DISABLE_AUTOUPDATE !== "1") process.exit(82);
  process.argv.push("--agent-name", "OpenCode", "--agent-version", "1.18.29");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            );
            await chmod(openCodePath, 0o700);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: {
                    OPENCODE_DISABLE_AUTOUPDATE: "0",
                    PATH: temporaryDirectory,
                },
                signal: new AbortController().signal,
                specifications: [new OpenCodeAgentSpecification()],
            });

            expect(inventory.unavailable).toEqual([]);
            expect(inventory.available).toHaveLength(1);
            const discovered = inventory.available[0];
            if (!(discovered instanceof AvailableAgent)) {
                throw new Error("OpenCode was not discovered");
            }
            const canonicalExecutable = await realpath(openCodePath);
            expect(discovered.agent.command).toBe(canonicalExecutable);
            expect(discovered.agent.agentIdentity.realPath).toBe(canonicalExecutable);
            expect(discovered.agent.adapterIdentity.realPath).toBe(canonicalExecutable);
            expect(discovered.agent.arguments).toEqual(["acp"]);
            expect(discovered.agent.environment).toEqual({
                OPENCODE_DISABLE_AUTOUPDATE: "1",
            });
            expect(discovered.agent.agentVersion).toBe("1.18.29");
            expect(discovered.agent.adapterVersion).toBe("1.18.29");

            const chunks: string[] = [];
            await manager.runPrompt({
                additionalDirectories: [],
                agent: discovered.agent,
                commandId: "opencode-command",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    chunks.push(text);
                    return Promise.resolve();
                },
                prompt: "use the verified OpenCode executable",
                resources: [],
                sessionId: "opencode-session",
                signal: new AbortController().signal,
            });
            expect(chunks.join("")).toBe("OpenCode turn 1: use the verified OpenCode executable");
        } finally {
            await manager.close();
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
                const canonicalManagedPath = await realpath(managedPath);
                expect(discovered.agent.command).toBe(canonicalManagedPath);
                expect(discovered.agent.adapterIdentity.realPath).toBe(canonicalManagedPath);
                expect(discovered.agent.agentIdentity.realPath).toBe(canonicalManagedPath);
            } finally {
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );
});
