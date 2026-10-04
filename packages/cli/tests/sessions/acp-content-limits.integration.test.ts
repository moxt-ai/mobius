import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AcpActivity } from "../../src/acp/activity.ts";
import { AgentRuntimeManager } from "../../src/acp/agent-runtime-manager.ts";

import { fakeAgent, RecordingObserver } from "./acp-feature-fixture.ts";

describe("acp content limits", () => {
    it("Given an ACP tool returns inline image bytes, When Mobius records the tool update, Then it keeps the validated inline raster", async () => {
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager(observer);
        const activities: AcpActivity[] = [];
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "image-command",
                cwd: process.cwd(),
                images: [],
                onActivity: (activity) => {
                    activities.push(activity);
                    return Promise.resolve();
                },
                onText: () => Promise.resolve(),
                prompt: "generate inline image",
                resources: [],
                sessionId: "image-session",
                signal: new AbortController().signal,
            });

            expect(
                activities.some((activity) =>
                    activity.content.some(
                        (content) => content.type === "image" && content.artifactId === "" && content.data.length > 0,
                    ),
                ),
            ).toBe(true);
        } finally {
            await manager.close();
        }
    });

    it("Given two Turns reuse a tool ID, When each Turn produces an image, Then the image stays in each tool activity without a separate content event", async () => {
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager(observer);
        const activities: AcpActivity[] = [];
        try {
            for (const commandId of ["first-image-turn", "second-image-turn"]) {
                await manager.runPrompt({
                    additionalDirectories: [],
                    agent: fakeAgent(),
                    commandId,
                    cwd: process.cwd(),
                    images: [],
                    onActivity: (activity) => {
                        activities.push(activity);
                        return Promise.resolve();
                    },
                    onText: () => Promise.resolve(),
                    prompt: "generate inline image with reused tool id",
                    resources: [],
                    sessionId: "reused-image-session",
                    signal: new AbortController().signal,
                });
            }
            expect(
                activities.filter((activity) => activity.content.some((content) => content.type === "image")),
            ).toHaveLength(2);
            expect(observer.content).toHaveLength(0);
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP tool returns more than 500,000 characters, When Mobius records the tool update, Then it truncates the visible output at 500,000 characters", async () => {
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager(observer);
        const activities: AcpActivity[] = [];
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "oversized-tool-output-command",
                cwd: process.cwd(),
                images: [],
                onActivity: (activity) => {
                    activities.push(activity);
                    return Promise.resolve();
                },
                onText: () => Promise.resolve(),
                prompt: "return oversized tool output",
                resources: [],
                sessionId: "oversized-tool-output-session",
                signal: new AbortController().signal,
            });

            const completedTool = activities.findLast(
                (activity) => activity.activityType === "tool" && activity.status === "completed",
            );
            expect(completedTool?.output).toHaveLength(500_000);
            expect(completedTool?.output).toMatch(/… output truncated by Mobius$/);
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent streams a long reasoning Turn, When it completes, Then the Runtime receives a bounded snapshot", async () => {
        const manager = new AgentRuntimeManager(new RecordingObserver());
        const activities: AcpActivity[] = [];
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "oversized-reasoning-command",
                cwd: process.cwd(),
                images: [],
                onActivity: (activity) => {
                    activities.push(activity);
                    return Promise.resolve();
                },
                onText: () => Promise.resolve(),
                prompt: "stream oversized reasoning",
                resources: [],
                sessionId: "oversized-reasoning-session",
                signal: new AbortController().signal,
            });
            const completed = activities.findLast(
                (activity) => activity.activityType === "reasoning" && activity.status === "completed",
            );
            expect(completed?.output.length).toBeLessThanOrEqual(500_000);
            expect(completed?.detail.kind).toBe("truncated");
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP agent links a local image in Markdown, When Mobius records the reply, Then it preserves the original path for on-demand reading", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-markdown-image-"));
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager(observer);
        const output: string[] = [];
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "markdown-image-command",
                cwd: directory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    output.push(text);
                    return Promise.resolve();
                },
                prompt: "generate markdown image",
                resources: [],
                sessionId: "markdown-image-session",
                signal: new AbortController().signal,
            });

            expect(output.join("")).toContain(
                `![Generated image](<${await realpath(join(directory, "generated-image.png"))}>`,
            );
            expect(observer.content).toEqual([]);
        } finally {
            await manager.close();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("Given an ACP Agent links an image outside its workspace, When Mobius records the reply, Then it preserves the Agent path", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "mobius-agent-workspace-"));
        const generatedImages = await mkdtemp(join(tmpdir(), "mobius-agent-generated-images-"));
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager(observer);
        const output: string[] = [];
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent([], { FAKE_ACP_IMAGE_DIRECTORY: generatedImages }),
                commandId: "codex-generated-image-command",
                cwd: workspace,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    output.push(text);
                    return Promise.resolve();
                },
                prompt: "generate markdown image",
                resources: [],
                sessionId: "codex-generated-image-session",
                signal: new AbortController().signal,
            });

            expect(output.join("")).toContain(`![Generated image](<${join(generatedImages, "generated-image.png")}>`);
            expect(observer.content).toEqual([]);
        } finally {
            await manager.close();
            await Promise.all([
                rm(workspace, { force: true, recursive: true }),
                rm(generatedImages, { force: true, recursive: true }),
            ]);
        }
    });

    it("Given an ACP agent returns image and video output, When Mobius records the reply, Then local images stay referenced and inline videos stay inline", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-media-output-"));
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager(observer);
        const output: string[] = [];
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "media-command",
                cwd: directory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    output.push(text);
                    return Promise.resolve();
                },
                prompt: "generate media artifacts",
                resources: [],
                sessionId: "media-session",
                signal: new AbortController().signal,
            });

            expect(output.join("")).toContain(
                `![Generated image](<${await realpath(join(directory, "generated-image.png"))}>`,
            );
            expect(observer.content).toContainEqual(
                expect.objectContaining({
                    content: expect.objectContaining({
                        artifactId: "",
                        data: "AAAAGGZ0eXBpc29tAAACAGlzb21pc28y",
                        mimeType: "video/mp4",
                        name: "generated-video.mp4",
                        type: "video",
                    }),
                }),
            );
        } finally {
            await manager.close();
            await rm(directory, { force: true, recursive: true });
        }
    });
});
