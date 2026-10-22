import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpContentExternalizer } from "../../src/acp/content/content-externalizer.ts";
import { AgentRuntimeManager } from "../../src/session/manager/session-manager.ts";
import { MemoryAcpSessionStore } from "../../src/session/record/session-store.ts";
import { systemTimer } from "../../src/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";

import { fakeAgent, RecordingObserver } from "./acp-feature-fixture.ts";

describe("acp content limits", () => {
    it("Given an ACP tool returns inline image bytes, When Mobius records the tool update, Then the live event exposes an external image reference without inline bytes", async () => {
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
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "image-command",
                cwd: process.cwd(),
                images: [],
                prompt: "generate inline image",
                resources: [],
                sessionId: "image-session",
                signal: new AbortController().signal,
            });

            const completed = observer
                .toolUpdates("tool-1")
                .findLast((update) => update.sessionUpdate === "tool_call_update");
            expect(completed).toMatchObject({
                sessionUpdate: "tool_call_update",
                status: "completed",
            });
            expect(
                observer
                    .acpUpdates()
                    .findLast(
                        (update) =>
                            update.sessionUpdate === "tool_call_update" &&
                            (update.content ?? []).some(
                                (item) => item.type === "content" && item.content.type === "external_image",
                            ),
                    ),
            ).toBeDefined();
        } finally {
            await manager.close();
        }
    });

    it("Given two Turns reuse a tool ID, When each Turn produces an image, Then each turn records its own external image event", async () => {
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
        try {
            for (const commandId of ["first-image-turn", "second-image-turn"]) {
                await manager.runPrompt({
                    additionalDirectories: [],
                    agent: fakeAgent(),
                    commandId,
                    cwd: process.cwd(),
                    images: [],
                    prompt: "generate inline image with reused tool id",
                    resources: [],
                    sessionId: "reused-image-session",
                    signal: new AbortController().signal,
                });
            }
            expect(
                observer
                    .acpUpdates()
                    .filter(
                        (update) =>
                            (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
                            update.toolCallId === "reused-image-tool" &&
                            (update.content ?? []).some(
                                (item) => item.type === "content" && item.content.type === "external_image",
                            ),
                    ),
            ).toHaveLength(2);
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP tool returns more than 500,000 characters, When Mobius records the tool update, Then the raw output stays intact in the event log", async () => {
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
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "oversized-tool-output-command",
                cwd: process.cwd(),
                images: [],
                prompt: "return oversized tool output",
                resources: [],
                sessionId: "oversized-tool-output-session",
                signal: new AbortController().signal,
            });

            const completed = observer
                .toolUpdates("tool-1")
                .findLast((update) => update.sessionUpdate === "tool_call_update");
            expect(completed).toMatchObject({ rawOutput: "x".repeat(500_001), status: "completed" });
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent streams a long reasoning turn, When it completes, Then every reasoning chunk lands in the event log", async () => {
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
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "oversized-reasoning-command",
                cwd: process.cwd(),
                images: [],
                prompt: "stream oversized reasoning",
                resources: [],
                sessionId: "oversized-reasoning-session",
                signal: new AbortController().signal,
            });
            const reasoning = observer
                .acpUpdates()
                .map((update) =>
                    update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text"
                        ? update.content.text.length
                        : null,
                )
                .filter((length): length is number => length !== null);
            expect(reasoning).toEqual([
                "Inspecting ".length,
                "the workspace".length,
                ...Array.from({ length: 8 }, () => 100_000),
            ]);
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP agent links a local image in Markdown, When Mobius records the reply, Then the reply text preserves the original path", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-markdown-image-"));
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
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "markdown-image-command",
                cwd: directory,
                images: [],
                prompt: "generate markdown image",
                resources: [],
                sessionId: "markdown-image-session",
                signal: new AbortController().signal,
            });

            expect(observer.agentText()).toContain(
                `![Generated image](<${await realpath(join(directory, "generated-image.png"))}`,
            );
        } finally {
            await manager.close();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("Given an ACP Agent links an image outside its workspace, When Mobius records the reply, Then the reply text preserves the Agent path", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "mobius-agent-workspace-"));
        const generatedImages = await mkdtemp(join(tmpdir(), "mobius-agent-generated-images-"));
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
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent([], { FAKE_ACP_IMAGE_DIRECTORY: generatedImages }),
                commandId: "codex-generated-image-command",
                cwd: workspace,
                images: [],
                prompt: "generate markdown image",
                resources: [],
                sessionId: "codex-generated-image-session",
                signal: new AbortController().signal,
            });

            expect(observer.agentText()).toContain(
                `![Generated image](<${join(generatedImages, "generated-image.png")}`,
            );
        } finally {
            await manager.close();
            await Promise.all([
                rm(workspace, { force: true, recursive: true }),
                rm(generatedImages, { force: true, recursive: true }),
            ]);
        }
    });

    it("Given an ACP agent returns image and video output, When Mobius records the reply, Then the image stays referenced in text and the video is externalized", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-media-output-"));
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
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "media-command",
                cwd: directory,
                images: [],
                prompt: "generate media artifacts",
                resources: [],
                sessionId: "media-session",
                signal: new AbortController().signal,
            });

            expect(observer.agentText()).toContain(
                `![Generated image](<${await realpath(join(directory, "generated-image.png"))}`,
            );
            expect(
                observer
                    .acpUpdates()
                    .findLast(
                        (update) =>
                            update.sessionUpdate === "agent_message_chunk" &&
                            update.content.type === "external_resource",
                    ),
            ).toMatchObject({
                content: {
                    byteLength: 24,
                    encoding: "binary",
                    mimeType: "video/mp4",
                    resourceKey: expect.any(String),
                    type: "external_resource",
                    uri: "file:///generated-video.mp4",
                },
                sessionUpdate: "agent_message_chunk",
            });
        } finally {
            await manager.close();
            await rm(directory, { force: true, recursive: true });
        }
    });
});
