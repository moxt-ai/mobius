import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { acpAdapters } from "../../src/acp/adapter/registry.ts";
import { AgentRuntimeManager } from "../../src/acp/agent-runtime-manager.ts";
import { NullAcpSessionObserver } from "../../src/acp/session-contracts.ts";
import { MemoryAcpSessionStore } from "../../src/acp/session-store.ts";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { discoverLocalAgentInventory } from "../../src/agent-catalog/discover-local-agents.ts";
import { systemDaemonTimer } from "../../src/daemon/relay/timer.ts";
import { AcpContentExternalizer } from "../../src/external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "../../src/external-content/local-external-content-store.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given real Codex initializes but its process is killed during model discovery, When discovery completes, Then the dead backend is unavailable", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "DISCOVERY_REPLY");
    await using codex = await CodexFixture.create(provider);
    const directory = await mkdtemp(join(tmpdir(), "mobius-real-codex-exit-"));
    try {
        const executable = join(directory, "codex.mjs");
        await writeFile(
            executable,
            `#!${process.execPath}
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const child = spawn(${JSON.stringify(codex.executable)}, process.argv.slice(2), { stdio: ["pipe", "inherit", "inherit"], env: {...process.env, ...${JSON.stringify(codex.environment)}} });
createInterface({input:process.stdin}).on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "model/list") child.kill("SIGKILL");
    else child.stdin.write(line + "\\n");
});
child.once("error", () => process.exit(1));
child.once("exit", code => process.exit(code ?? 1));
`,
            { mode: 0o700 },
        );
        const inventory = await discoverLocalAgentInventory({
            defaultWorkspace: directory,
            environment: { ...codex.environment, MOBIUS_CODEX_PATH: executable },
            signal: AbortSignal.timeout(30_000),
            specifications: [new CodexAgentSpecification()],
        });
        expect(inventory.available).toEqual([]);
        expect(inventory.unavailable).toEqual([
            expect.objectContaining({
                specification: expect.objectContaining({ id: "codex" }),
                status: "incompatible_adapter",
            }),
        ]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test.skipIf(process.platform === "win32")(
    "Given a discovered real Codex executable changes, When the existing conversation continues and a new one opens, Then the existing process works and the new runtime is rejected",
    async () => {
        await using provider = await FakeOpenAiProvider.start("mobius-test-model", "IDENTITY_REPLY");
        await using codex = await CodexFixture.create(provider);
        const directory = await mkdtemp(join(tmpdir(), "mobius-real-codex-identity-"));
        const manager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        try {
            const first = join(directory, "first.mjs");
            const second = join(directory, "second.mjs");
            const link = join(directory, "codex");
            await codex.writeLauncher(first);
            await codex.writeLauncher(second);
            await symlink(first, link);
            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: directory,
                environment: { ...codex.environment, MOBIUS_CODEX_PATH: link },
                signal: AbortSignal.timeout(30_000),
                specifications: [new CodexAgentSpecification()],
            });
            const agent = inventory.readyAgents()[0];
            if (agent === undefined) {
                throw new Error("Real Codex was not discovered");
            }
            const run = async (sessionId: string): Promise<string> => {
                let text = "";
                await manager.runPrompt({
                    agent,
                    sessionId,
                    cwd: directory,
                    additionalDirectories: [],
                    commandId: crypto.randomUUID(),
                    prompt: "Hello",
                    images: [],
                    resources: [],
                    signal: AbortSignal.timeout(30_000),
                    onActivity: async () => {},
                    onText: async (chunk) => {
                        text += chunk;
                    },
                });
                return text;
            };
            expect(await run("existing")).toContain("IDENTITY_REPLY");
            await unlink(link);
            await symlink(second, link);
            expect(await run("existing")).toContain("IDENTITY_REPLY");
            await expect(run("new")).rejects.toMatchObject({ code: "agent_runtime_changed" });
        } finally {
            await manager.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
);
