import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntimeManager } from "../../src/acp/agent-runtime-manager.ts";
import { createDaemonConfig, DaemonLocalContext, LocalAgentDefinition } from "../../src/config.ts";

import { fakeAgent, fakeAgentPath, RecordingObserver } from "./acp-feature-fixture.ts";

describe("acp commands environment", () => {
    it("Given an ACP Agent has not advertised commands, When Mobius prepares a session, Then it does not invent compact", async () => {
        const manager = new AgentRuntimeManager();
        const agent = new LocalAgentDefinition("opencode", "OpenCode", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "OpenCode",
        ]);

        try {
            const prepared = await manager.prepareSession({
                additionalDirectories: [],
                agent,
                cwd: process.cwd(),
                sessionId: "opencode-compact-session",
                signal: new AbortController().signal,
            });

            expect(prepared.commands).toEqual([]);
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP Agent advertises compact, When its commands update, Then Mobius preserves the ACP command", async () => {
        const agentId = "unknown-acp";
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager(observer);
        const agent = fakeAgent(["--advertise-compact-command"], {}, agentId);

        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: `${agentId}-compact-command`,
                cwd: process.cwd(),
                images: [],
                onActivity: () => Promise.resolve(),
                onText: () => Promise.resolve(),
                prompt: "advertise commands",
                resources: [],
                sessionId: `${agentId}-compact-session`,
                signal: new AbortController().signal,
            });

            expect(observer.commands.at(-1)?.commands).toEqual([
                {
                    description: "Review the current workspace",
                    inputHint: "optional focus",
                    name: "review",
                },
                {
                    description: "Compact the current conversation",
                    inputHint: "",
                    name: "compact",
                },
            ]);
        } finally {
            await manager.close();
        }
    });

    it("Given a managed Runtime has a login-shell-only Agent environment, When it starts an ACP session, Then the Agent receives that environment", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "mobius-login-shell-workspace-"));
        const generatedImages = await mkdtemp(join(tmpdir(), "mobius-login-shell-images-"));
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager(observer);
        let answer = "";
        const localContext = new DaemonLocalContext(join(workspace, "state"), {
            FAKE_ACP_IMAGE_DIRECTORY: generatedImages,
            PATH: process.env["PATH"] ?? "",
        });
        const config = createDaemonConfig(
            {
                channelId: "login-shell-environment",
                defaultWorkspace: workspace,
                relayUrl: new URL("ws://127.0.0.1:8787/v1/runtimes/connect?token=test"),
            },
            [fakeAgent()],
            [],
            localContext,
        );
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: config.catalog.find("codex"),
                commandId: "login-shell-command",
                cwd: workspace,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    answer += text;
                    return Promise.resolve();
                },
                prompt: "generate markdown image",
                resources: [],
                sessionId: "login-shell-session",
                signal: new AbortController().signal,
            });

            expect(answer).toContain(join(generatedImages, "generated-image.png"));
            expect(observer.content).toHaveLength(0);
        } finally {
            await manager.close();
            await Promise.all([
                rm(workspace, { force: true, recursive: true }),
                rm(generatedImages, { force: true, recursive: true }),
            ]);
        }
    });
});
