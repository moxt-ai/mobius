import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntimeManager } from "../../../packages/cli/src/acp/agent-runtime-manager.ts";
import { MemoryAcpSessionStore } from "../../../packages/cli/src/acp/session-store.ts";

import { fakeAgent, RecordingObserver } from "./acp-feature-fixture.ts";

describe("acp interactions", () => {
    it("Given an Agent turn is running, When a targeted steering prompt is submitted, Then it is injected into that exact turn and preserves the Agent message anchor", async () => {
        const manager = new AgentRuntimeManager();
        const signal = new AbortController().signal;
        const activityArrived = Promise.withResolvers<void>();
        const output: { readonly messageId: string; readonly text: string }[] = [];
        try {
            const running = manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "running-command",
                cwd: process.cwd(),
                images: [],
                onActivity: () => {
                    activityArrived.resolve();
                    return Promise.resolve();
                },
                onText: (text, messageId) => {
                    output.push({ messageId, text });
                    return Promise.resolve();
                },
                prompt: "wait for steering",
                resources: [],
                sessionId: "steering-session",
                signal,
            });
            await activityArrived.promise;

            await expect(
                manager.steerPrompt({
                    additionalDirectories: [],
                    agent: fakeAgent(),
                    commandId: "steering-command",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "focus on the requested fix",
                    resources: [],
                    sessionId: "steering-session",
                    signal,
                    targetCommandId: "running-command",
                }),
            ).resolves.toBe("injected");
            await expect(running).resolves.toMatchObject({ stopReason: "end_turn" });
            expect(output).toContainEqual({
                messageId: "assistant-1",
                text: "Steered: focus on the requested fix",
            });
        } finally {
            await manager.close();
        }
    });

    it("Given a new browser conversation, When its ACP session is prepared and configured, Then mode, model, effort, fast mode, capabilities, commands, usage, permissions, elicitation, and rich content are available", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-features-"));
        const previousState = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = temporaryDirectory;
        await mkdir(join(temporaryDirectory, "shared"));
        const observer = new RecordingObserver();
        const store = new MemoryAcpSessionStore();
        const manager = new AgentRuntimeManager(observer, store);
        const signal = new AbortController().signal;

        try {
            const prepared = await manager.prepareSession({
                additionalDirectories: [join(temporaryDirectory, "shared")],
                agent: fakeAgent(),
                cwd: temporaryDirectory,
                sessionId: "browser-session",
                signal,
            });
            expect(prepared).toMatchObject({
                agentName: "Mobius test agent",
                capabilities: {
                    additionalDirectories: true,
                    embeddedContextPrompt: true,
                    imagePrompt: true,
                    loadSession: true,
                    promptQueueing: true,
                    resumeSession: true,
                    steering: true,
                },
                restored: false,
            });
            expect(prepared.configOptions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ category: "mode", id: "mode" }),
                    expect.objectContaining({ category: "model", id: "model" }),
                    expect.objectContaining({
                        category: "thought_level",
                        id: "reasoning_effort",
                    }),
                    expect.objectContaining({ id: "fast_mode", type: "boolean" }),
                ]),
            );

            const configured = await manager.configureSession({
                additionalDirectories: [join(temporaryDirectory, "shared")],
                agent: fakeAgent(),
                booleanValue: false,
                configId: "model",
                cwd: temporaryDirectory,
                requestId: "configure-1",
                sessionId: "browser-session",
                signal,
                value: "test-large",
                valueType: "select",
            });
            expect(configured).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        currentValue: "test-large",
                        id: "model",
                    }),
                ]),
            );

            await manager.configureSession({
                additionalDirectories: [join(temporaryDirectory, "shared")],
                agent: fakeAgent(),
                booleanValue: false,
                configId: "mode",
                cwd: temporaryDirectory,
                requestId: "configure-2",
                sessionId: "browser-session",
                signal,
                value: "plan",
                valueType: "select",
            });
            await manager.configureSession({
                additionalDirectories: [join(temporaryDirectory, "shared")],
                agent: fakeAgent(),
                booleanValue: false,
                configId: "reasoning_effort",
                cwd: temporaryDirectory,
                requestId: "configure-3",
                sessionId: "browser-session",
                signal,
                value: "high",
                valueType: "select",
            });
            await manager.configureSession({
                additionalDirectories: [join(temporaryDirectory, "shared")],
                agent: fakeAgent(),
                booleanValue: true,
                configId: "fast_mode",
                cwd: temporaryDirectory,
                requestId: "configure-4",
                sessionId: "browser-session",
                signal,
                value: "",
                valueType: "boolean",
            });

            const text: string[] = [];
            const activityContent: string[] = [];
            const running = manager.runPrompt({
                additionalDirectories: [join(temporaryDirectory, "shared")],
                agent: fakeAgent(),
                commandId: "command-1",
                cwd: temporaryDirectory,
                images: [
                    {
                        data: "aW1hZ2U=",
                        mimeType: "image/png",
                        name: "preview.png",
                    },
                ],
                onActivity: (activity) => {
                    activityContent.push(...activity.content.map((item) => item.type));
                    return Promise.resolve();
                },
                onText: (chunk) => {
                    text.push(chunk);
                    return Promise.resolve();
                },
                prompt: "exercise ACP controls",
                resources: [
                    {
                        mimeType: "text/plain",
                        name: "context.txt",
                        text: "supporting context",
                        type: "embedded",
                        uri: "mobius://upload/context.txt",
                    },
                ],
                sessionId: "browser-session",
                signal,
            });

            const permission = await observer.permissionArrived.promise;
            expect(permission).toMatchObject({
                commandId: "command-1",
                title: "Run the verification command",
            });
            await manager.respondPermission({
                interactionId: permission.interactionId,
                optionId: "allow-once",
                outcome: "selected",
                sessionId: "browser-session",
            });

            const elicitation = await observer.elicitationArrived.promise;
            expect(elicitation).toMatchObject({
                fields: [expect.objectContaining({ name: "branch", required: true })],
                mode: "form",
            });
            await manager.respondElicitation({
                action: "accept",
                content: JSON.stringify({ branch: "main" }),
                interactionId: elicitation.interactionId,
                sessionId: "browser-session",
            });

            await expect(running).resolves.toEqual({ stopReason: "end_turn" });
            expect(text.join("")).toContain("test-large");
            expect(text.join("")).toContain("plan");
            expect(text.join("")).toContain("high");
            expect(text.join("")).toContain("fast");
            expect(text.join("")).toContain("main");
            expect(observer.commands.at(-1)?.commands).toEqual(
                expect.arrayContaining([expect.objectContaining({ name: "review" })]),
            );
            expect(observer.usage.at(-1)).toMatchObject({
                costAmount: 0.125,
                costCurrency: "USD",
                hasCost: true,
                size: 200_000,
                used: 50_000,
            });
            expect(observer.information.at(-1)).toMatchObject({
                title: "ACP feature session",
                updatedAt: "2026-09-04T00:01:00.000Z",
            });
            expect(observer.content.at(-1)?.content).toMatchObject({
                mimeType: "image/png",
                type: "image",
            });
            expect(activityContent).toContain("diff");
            expect(activityContent).toContain("resource");
        } finally {
            await manager.close();
            if (previousState === undefined) {
                delete process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
            } else {
                process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = previousState;
            }
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given URL elicitation, When the user consents and the agent reports completion, Then the out-of-band interaction stays correlated through completion", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-url-"));
        const previousState = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = temporaryDirectory;
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager(observer);
        const signal = new AbortController().signal;

        try {
            await manager.prepareSession({
                additionalDirectories: [],
                agent: fakeAgent(),
                cwd: temporaryDirectory,
                sessionId: "url-browser-session",
                signal,
            });
            const running = manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "url-command",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: () => Promise.resolve(),
                prompt: "exercise URL elicitation",
                resources: [],
                sessionId: "url-browser-session",
                signal,
            });
            const elicitation = await observer.elicitationArrived.promise;
            expect(elicitation).toMatchObject({
                accepted: false,
                mode: "url",
                url: expect.stringContaining("https://example.com/connect/"),
            });

            await manager.respondElicitation({
                action: "accept",
                content: "",
                interactionId: elicitation.interactionId,
                sessionId: "url-browser-session",
            });

            await expect(running).resolves.toEqual({ stopReason: "end_turn" });
            expect(observer.elicitationResolutions.map((event) => event.action)).toEqual(["accept", "complete"]);
        } finally {
            await manager.close();
            if (previousState === undefined) {
                delete process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
            } else {
                process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = previousState;
            }
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
