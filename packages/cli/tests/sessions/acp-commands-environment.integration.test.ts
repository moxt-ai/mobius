import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpAdapters } from "../../src/acp/adapter/registry.ts";
import { AgentRuntimeManager } from "../../src/acp/agent-runtime-manager.ts";
import { NullAcpSessionObserver } from "../../src/acp/session-contracts.ts";
import { MemoryAcpSessionStore } from "../../src/acp/session-store.ts";
import { createRuntimeConfig, LocalAgentDefinition, RuntimeLocalContext } from "../../src/daemon/config.ts";
import { systemTimer } from "../../src/daemon/relay/timer.ts";
import { AcpContentExternalizer } from "../../src/external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "../../src/external-content/local-external-content-store.ts";

import { fakeAgent, fakeAgentPath, RecordingObserver } from "./acp-feature-fixture.ts";

describe("acp commands environment", () => {
    it("Given an ACP Agent has not advertised commands, When Mobius prepares a session, Then it does not invent compact", async () => {
        const manager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemTimer,
            maxProcesses: null,
        });
        const agent = new LocalAgentDefinition("controlled-acp", "Controlled ACP", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Controlled ACP",
        ]);

        try {
            const prepared = await manager.prepareSession({
                additionalDirectories: [],
                agent,
                cwd: process.cwd(),
                sessionId: "controlled-compact-session",
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
        const manager = new AgentRuntimeManager({
            observer,
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemTimer,
            maxProcesses: null,
        });
        const agent = fakeAgent(["--advertise-compact-command"], {}, agentId);

        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: `${agentId}-compact-command`,
                cwd: process.cwd(),
                images: [],
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
        const manager = new AgentRuntimeManager({
            observer,
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemTimer,
            maxProcesses: null,
        });
        const localContext = new RuntimeLocalContext(join(workspace, "state"), {
            FAKE_ACP_IMAGE_DIRECTORY: generatedImages,
            PATH: process.env["PATH"] ?? "",
        });
        const config = createRuntimeConfig(
            {
                channelId: "login-shell-environment",
                defaultWorkspace: workspace,
                relayUrl: new URL("ws://127.0.0.1:8787/v1/runtimes/connect?token=test"),
            },
            [fakeAgent()],
            localContext,
        );
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: config.catalog.find("codex"),
                commandId: "login-shell-command",
                cwd: workspace,
                images: [],
                prompt: "generate markdown image",
                resources: [],
                sessionId: "login-shell-session",
                signal: new AbortController().signal,
            });

            expect(observer.agentText()).toContain(join(generatedImages, "generated-image.png"));
        } finally {
            await manager.close();
            await Promise.all([
                rm(workspace, { force: true, recursive: true }),
                rm(generatedImages, { force: true, recursive: true }),
            ]);
        }
    });
});
