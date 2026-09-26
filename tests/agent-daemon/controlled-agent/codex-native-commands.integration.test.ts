import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntimeManager } from "../../../packages/cli/src/acp/agent-runtime-manager.ts";
import { CodexAcpAgent } from "../../../packages/cli/src/acp/codex/agent.ts";
import { InProcessAcpAgentDefinition } from "../../../packages/cli/src/agent-catalog/local-agent.ts";

describe("codex native commands", () => {
    it("Given Mobius owns the Codex ACP adapter, When a Session is prepared and compacted, Then ACP advertises compact and Codex completes it", async () => {
        const temporary = await realpath(await mkdtemp(join(tmpdir(), "mobius-codex-compact-")));
        const workspace = join(temporary, "workspace");
        await mkdir(workspace);
        const executable = join(temporary, "codex.mjs");
        const turnServer = new URL("../fixtures/fake-acp-agent/src/turn-app-server.ts", import.meta.url).toString();
        await writeFile(executable, `#!${process.execPath}\nawait import(${JSON.stringify(turnServer)});\n`, {
            mode: 0o700,
        });
        const agent = new InProcessAcpAgentDefinition(
            "codex",
            "Codex",
            executable,
            (options) => new CodexAcpAgent(options),
        );
        const sessions = new AgentRuntimeManager();
        const sessionId = crypto.randomUUID();
        try {
            const prepared = await sessions.prepareSession({
                additionalDirectories: [],
                agent,
                cwd: workspace,
                sessionId,
                signal: AbortSignal.timeout(20_000),
            });
            expect(prepared.commands).toEqual([
                { description: "Compact the conversation context", inputHint: "", name: "compact" },
            ]);

            await expect(
                sessions.runPrompt({
                    additionalDirectories: [],
                    agent,
                    commandId: crypto.randomUUID(),
                    cwd: workspace,
                    images: [],
                    onActivity: async () => {},
                    onText: async () => {},
                    prompt: "/compact",
                    resources: [],
                    sessionId,
                    signal: AbortSignal.timeout(20_000),
                }),
            ).resolves.toEqual({ stopReason: "end_turn" });
        } finally {
            await sessions.close();
            await rm(temporary, { recursive: true, force: true });
        }
    });

    it("Given Codex reports an unavailable configured model, When a new chat sends a prompt, Then a catalog model answers", async () => {
        const temporary = await realpath(await mkdtemp(join(tmpdir(), "mobius-codex-model-")));
        const workspace = join(temporary, "workspace");
        await mkdir(workspace);
        const executable = join(temporary, "codex.mjs");
        const turnServer = new URL("../fixtures/fake-acp-agent/src/turn-app-server.ts", import.meta.url).toString();
        await writeFile(executable, `#!${process.execPath}\nawait import(${JSON.stringify(turnServer)});\n`, {
            mode: 0o700,
        });
        const previous = process.env["MOBIUS_FAKE_CODEX_REPORT_UNAVAILABLE_MODEL"];
        process.env["MOBIUS_FAKE_CODEX_REPORT_UNAVAILABLE_MODEL"] = "1";
        const agent = new InProcessAcpAgentDefinition(
            "codex",
            "Codex",
            executable,
            (options) => new CodexAcpAgent(options),
        );
        const sessions = new AgentRuntimeManager();
        let answer = "";
        try {
            const result = await sessions.runPrompt({
                agent,
                additionalDirectories: [],
                cwd: workspace,
                signal: AbortSignal.timeout(20_000),
                sessionId: crypto.randomUUID(),
                commandId: crypto.randomUUID(),
                prompt: "Hello Codex",
                images: [],
                resources: [],
                onText: async (text) => {
                    answer += text;
                },
                onActivity: async () => {},
            });
            expect(result.stopReason).toBe("end_turn");
            expect(answer).toContain("Scripted Codex answer (scripted-small/medium/");
        } finally {
            await sessions.close();
            if (previous === undefined) {
                delete process.env["MOBIUS_FAKE_CODEX_REPORT_UNAVAILABLE_MODEL"];
            } else {
                process.env["MOBIUS_FAKE_CODEX_REPORT_UNAVAILABLE_MODEL"] = previous;
            }
            await rm(temporary, { recursive: true, force: true });
        }
    });

    // The restored Codex listing path: Mobius hosts the ACP Agent in-process and drives
    // `codex app-server` directly, so the fixture plays that protocol against the real adapter.
});
