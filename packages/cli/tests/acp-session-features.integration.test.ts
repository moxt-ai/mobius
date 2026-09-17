import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
    AgentContentEvent,
    SessionCommandsUpdatedEvent,
    SessionConfigUpdatedEvent,
    SessionElicitationRequestedEvent,
    SessionElicitationResolvedEvent,
    SessionInfoUpdatedEvent,
    SessionPermissionRequestedEvent,
    SessionPermissionResolvedEvent,
    SessionUsageUpdatedEvent,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";
import type { AcpActivity } from "../src/acp/activity.ts";
import { AcpSessionManager, type AcpSessionObserver } from "../src/acp/session-manager.ts";
import { SqliteAcpSessionStore } from "../src/acp/session-store.ts";
import type { LocalArtifact } from "../src/authorization/local-artifact.ts";
import { LocalAgentDefinition } from "../src/config.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

class RecordingObserver implements AcpSessionObserver {
    readonly commands: SessionCommandsUpdatedEvent[] = [];
    readonly config: SessionConfigUpdatedEvent[] = [];
    readonly content: AgentContentEvent[] = [];
    readonly elicitations: SessionElicitationRequestedEvent[] = [];
    readonly information: SessionInfoUpdatedEvent[] = [];
    readonly permissions: SessionPermissionRequestedEvent[] = [];
    readonly permissionResolutions: SessionPermissionResolvedEvent[] = [];
    readonly elicitationResolutions: SessionElicitationResolvedEvent[] = [];
    readonly usage: SessionUsageUpdatedEvent[] = [];
    readonly importedArtifacts: LocalArtifact[] = [];
    readonly importedImages: LocalArtifact[] = [];
    readonly permissionArrived = Promise.withResolvers<SessionPermissionRequestedEvent>();
    readonly elicitationArrived = Promise.withResolvers<SessionElicitationRequestedEvent>();

    readonly importLocalArtifact = (_sessionId: string, artifact: LocalArtifact): Promise<string> => {
        this.importedArtifacts.push(artifact);
        if (artifact.mimeType.startsWith("image/")) {
            this.importedImages.push(artifact);
        }
        return Promise.resolve(
            artifact.mimeType.startsWith("video/") ? "artifact-inline-video" : "artifact-inline-image",
        );
    };

    readonly onCommands = (event: SessionCommandsUpdatedEvent): Promise<void> => {
        this.commands.push(event);
        return Promise.resolve();
    };

    readonly onConfig = (event: SessionConfigUpdatedEvent): Promise<void> => {
        this.config.push(event);
        return Promise.resolve();
    };

    readonly onContent = (event: AgentContentEvent): Promise<void> => {
        this.content.push(event);
        return Promise.resolve();
    };

    readonly onElicitation = (event: SessionElicitationRequestedEvent): Promise<void> => {
        this.elicitations.push(event);
        this.elicitationArrived.resolve(event);
        return Promise.resolve();
    };

    readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
        this.information.push(event);
        return Promise.resolve();
    };

    readonly onPermission = (event: SessionPermissionRequestedEvent): Promise<void> => {
        this.permissions.push(event);
        this.permissionArrived.resolve(event);
        return Promise.resolve();
    };

    readonly onPermissionResolved = (event: SessionPermissionResolvedEvent): Promise<void> => {
        this.permissionResolutions.push(event);
        return Promise.resolve();
    };

    readonly onElicitationResolved = (event: SessionElicitationResolvedEvent): Promise<void> => {
        this.elicitationResolutions.push(event);
        return Promise.resolve();
    };

    readonly onUsage = (event: SessionUsageUpdatedEvent): Promise<void> => {
        this.usage.push(event);
        return Promise.resolve();
    };
}

function fakeAgent(additionalArguments: readonly string[] = []): LocalAgentDefinition {
    return new LocalAgentDefinition("codex", "Codex", process.execPath, [
        fakeAgentPath,
        "--agent-name",
        "Codex",
        ...additionalArguments,
    ]);
}

describe("ACP session features", () => {
    it("Given an ACP tool returns inline image bytes, When Mobius records the tool update, Then it uploads a validated raster and references its artifact", async () => {
        const observer = new RecordingObserver();
        const manager = new AcpSessionManager(observer);
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

            expect(observer.importedImages).toHaveLength(1);
            expect(observer.importedImages[0]).toMatchObject({ mimeType: "image/png" });
            expect(observer.importedImages[0]?.bytes.subarray(0, 4)).toEqual(Uint8Array.of(0x89, 0x50, 0x4e, 0x47));
            expect(
                activities.some((activity) =>
                    activity.content.some(
                        (content) =>
                            content.type === "image" &&
                            content.artifactId === "artifact-inline-image" &&
                            content.data.length === 0,
                    ),
                ),
            ).toBe(true);
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP agent links an authorized local image in Markdown, When Mobius records the reply, Then it uploads the image instead of forwarding an unavailable link", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-markdown-image-"));
        const observer = new RecordingObserver();
        const manager = new AcpSessionManager(observer);
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

            expect(output.join("")).not.toContain("![Generated image]");
            expect(observer.importedImages).toHaveLength(1);
            expect(observer.importedImages[0]).toMatchObject({ mimeType: "image/png", name: "generated-image.png" });
            expect(observer.content).toContainEqual(
                expect.objectContaining({
                    content: expect.objectContaining({
                        artifactId: "artifact-inline-image",
                        name: "generated-image.png",
                        type: "image",
                    }),
                }),
            );
        } finally {
            await manager.close();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("Given an ACP agent returns image and video output, When Mobius records the reply, Then both validated media artifacts remain available by reference", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-media-output-"));
        const observer = new RecordingObserver();
        const manager = new AcpSessionManager(observer);
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "media-command",
                cwd: directory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: () => Promise.resolve(),
                prompt: "generate media artifacts",
                resources: [],
                sessionId: "media-session",
                signal: new AbortController().signal,
            });

            expect(observer.importedArtifacts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ mimeType: "image/png", name: "generated-image.png" }),
                    expect.objectContaining({ mimeType: "video/mp4", name: "generated-video.mp4" }),
                ]),
            );
            expect(observer.content).toContainEqual(
                expect.objectContaining({
                    content: expect.objectContaining({
                        artifactId: "artifact-inline-video",
                        data: "",
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

    it("Given an Agent turn is running, When a targeted steering prompt is submitted, Then it is injected into that exact turn and preserves the Agent message anchor", async () => {
        const manager = new AcpSessionManager();
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

    it("Given an Agent lacks native prompt queueing, When Mobius dispatches a queued follow-up, Then the Agent executes it as the next turn", async () => {
        const manager = new AcpSessionManager();
        const output: string[] = [];
        try {
            const result = await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(["--no-prompt-queueing"]),
                commandId: "queued-command",
                cwd: process.cwd(),
                disposition: "queue",
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    output.push(text);
                    return Promise.resolve();
                },
                prompt: "queued follow-up",
                resources: [],
                sessionId: "mobius-queued-session",
                signal: new AbortController().signal,
                targetCommandId: "prior-command",
            });
            expect(result).toMatchObject({ stopReason: "end_turn" });
            expect(output.join("")).toBe("Codex turn 1: queued follow-up");
        } finally {
            await manager.close();
        }
    });

    it.each([
        ["absent usage", false, "end_turn"],
        ["unknown metadata", false, "end_turn"],
        ["empty quota", true, "end_turn"],
        ["usage only", true, "end_turn"],
        ["quota only", true, "end_turn"],
        ["cancelled usage", true, "cancelled"],
    ])(
        "Given %s in a final response, When a prompt settles, Then only reported data is preserved without inventing context usage",
        async (scenario, reportsUsage, stopReason) => {
            const observer = new RecordingObserver();
            const manager = new AcpSessionManager(observer);
            try {
                const result = await manager.runPrompt({
                    additionalDirectories: [],
                    agent: fakeAgent(),
                    commandId: "optional-command",
                    cwd: process.cwd(),
                    images: [],
                    onActivity: () => Promise.resolve(),
                    onText: () => Promise.resolve(),
                    prompt: `report ${scenario}`,
                    resources: [],
                    sessionId: "optional-session",
                    signal: new AbortController().signal,
                });
                expect(result.stopReason).toBe(stopReason);
                expect(observer.usage).toHaveLength(reportsUsage ? 1 : 0);
                if (reportsUsage) {
                    expect(observer.usage[0]).toMatchObject({
                        source: "prompt",
                        usage: result.usage ?? null,
                        _meta: result._meta ?? null,
                    });
                    expect(observer.usage[0]).not.toHaveProperty("used");
                }
                expect(JSON.stringify(result)).not.toContain("privateData");
            } finally {
                await manager.close();
            }
        },
    );

    it.each(["Codex", "Claude"])(
        "Given %s final usage, When a prompt completes, Then the runtime preserves validated tokens and quota alongside context usage",
        async (agent) => {
            const observer = new RecordingObserver();
            const manager = new AcpSessionManager(observer);
            try {
                const result = await manager.runPrompt({
                    additionalDirectories: [],
                    agent: fakeAgent(),
                    commandId: "usage-command",
                    cwd: process.cwd(),
                    images: [],
                    onActivity: () => Promise.resolve(),
                    onText: () => Promise.resolve(),
                    prompt: `report ${agent} usage`,
                    resources: [],
                    sessionId: "usage-session",
                    signal: new AbortController().signal,
                });
                expect(result).toMatchObject({
                    stopReason: "end_turn",
                    usage: {
                        totalTokens: agent === "Codex" ? 1_000 : 1_100,
                        cachedReadTokens: 200,
                    },
                    _meta: {
                        quota: {
                            model_usage: [
                                expect.objectContaining({
                                    model: agent === "Codex" ? "gpt-5" : "claude-sonnet",
                                }),
                            ],
                        },
                    },
                });
                expect(JSON.stringify(result)).not.toContain("privateData");
                expect(observer.usage).toMatchObject([
                    { source: "context", used: 50_000 },
                    { source: "prompt", commandId: "usage-command" },
                ]);
            } finally {
                await manager.close();
            }
        },
    );

    it("Given Gemini CLI snake-case quota metadata, When a prompt completes, Then the response succeeds with normalized bounded usage", async () => {
        const observer = new RecordingObserver();
        const manager = new AcpSessionManager(observer);
        try {
            const result = await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "gemini-usage-command",
                cwd: process.cwd(),
                images: [],
                onActivity: () => Promise.resolve(),
                onText: () => Promise.resolve(),
                prompt: "report Gemini usage",
                resources: [],
                sessionId: "gemini-usage-session",
                signal: new AbortController().signal,
            });
            expect(result).toMatchObject({
                _meta: {
                    quota: {
                        model_usage: [
                            {
                                model: "gemini-3.1-pro-preview",
                                token_count: { inputTokens: 600, outputTokens: 200, totalTokens: 800 },
                            },
                        ],
                        token_count: { inputTokens: 600, outputTokens: 200, totalTokens: 800 },
                    },
                },
                stopReason: "end_turn",
            });
            expect(observer.usage).toMatchObject([
                {
                    _meta: { quota: { token_count: { totalTokens: 800 } } },
                    commandId: "gemini-usage-command",
                    source: "prompt",
                    usage: null,
                },
            ]);
        } finally {
            await manager.close();
        }
    });

    it.each(["usage", "quota"])(
        "Given malformed final %s, When a prompt completes, Then invalid data is rejected with a sanitized typed failure",
        async (field) => {
            const observer = new RecordingObserver();
            const manager = new AcpSessionManager(observer);
            try {
                await expect(
                    manager.runPrompt({
                        additionalDirectories: [],
                        agent: fakeAgent(),
                        commandId: "invalid-command",
                        cwd: process.cwd(),
                        images: [],
                        onActivity: () => Promise.resolve(),
                        onText: () => Promise.resolve(),
                        prompt: `report invalid ${field}`,
                        resources: [],
                        sessionId: "invalid-session",
                        signal: new AbortController().signal,
                    }),
                ).rejects.toMatchObject({
                    code: "acp_invalid_prompt_response",
                    message: "ACP agent returned an invalid prompt response",
                });
                expect(observer.usage).toEqual([]);
            } finally {
                await manager.close();
            }
        },
    );

    it("Given a new browser conversation, When its ACP session is prepared and configured, Then mode, model, effort, fast mode, capabilities, commands, usage, permissions, elicitation, and rich content are available", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-features-"));
        const previousState = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = temporaryDirectory;
        await mkdir(join(temporaryDirectory, "shared"));
        const observer = new RecordingObserver();
        const store = new SqliteAcpSessionStore(join(temporaryDirectory, "sessions.sqlite"));
        const manager = new AcpSessionManager(observer, store);
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
            store.close();
            if (previousState === undefined) {
                delete process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
            } else {
                process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = previousState;
            }
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a persisted native ACP session, When the daemon session manager restarts, Then it resumes the same agent context", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-resume-"));
        const previousState = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = temporaryDirectory;
        const databasePath = join(temporaryDirectory, "sessions.sqlite");
        const signal = new AbortController().signal;

        try {
            const firstStore = new SqliteAcpSessionStore(databasePath);
            const first = new AcpSessionManager(new RecordingObserver(), firstStore);
            await first.prepareSession({
                additionalDirectories: [],
                agent: fakeAgent(),
                cwd: temporaryDirectory,
                sessionId: "resumable-browser-session",
                signal,
            });
            const firstText: string[] = [];
            await first.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId: "first-command",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (chunk) => {
                    firstText.push(chunk);
                    return Promise.resolve();
                },
                prompt: "first",
                resources: [],
                sessionId: "resumable-browser-session",
                signal,
            });
            await first.close();
            firstStore.close();

            const secondStore = new SqliteAcpSessionStore(databasePath);
            const second = new AcpSessionManager(new RecordingObserver(), secondStore);
            try {
                const prepared = await second.prepareSession({
                    additionalDirectories: [],
                    agent: fakeAgent(),
                    cwd: temporaryDirectory,
                    sessionId: "resumable-browser-session",
                    signal,
                });
                expect(prepared.restored).toBe(true);
                const secondText: string[] = [];
                await second.runPrompt({
                    additionalDirectories: [],
                    agent: fakeAgent(),
                    commandId: "second-command",
                    cwd: temporaryDirectory,
                    images: [],
                    onActivity: () => Promise.resolve(),
                    onText: (chunk) => {
                        secondText.push(chunk);
                        return Promise.resolve();
                    },
                    prompt: "second",
                    resources: [],
                    sessionId: "resumable-browser-session",
                    signal,
                });
                expect(firstText.join("")).toBe("Codex turn 1: first");
                expect(secondText.join("")).toBe("Codex turn 2: second");
            } finally {
                await second.close();
                secondStore.close();
            }
        } finally {
            if (previousState === undefined) {
                delete process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
            } else {
                process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = previousState;
            }
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a Mobius conversation has multiple completed turns, When it is forked at an earlier Agent message, Then the native fork contains exactly the selected history prefix", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-turn-fork-"));
        const previousState = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = temporaryDirectory;
        const store = new SqliteAcpSessionStore(join(temporaryDirectory, "sessions.sqlite"));
        const manager = new AcpSessionManager(new RecordingObserver(), store);
        const signal = new AbortController().signal;
        const prompt = async (sessionId: string, commandId: string, text: string): Promise<string> => {
            const output: string[] = [];
            await manager.runPrompt({
                additionalDirectories: [],
                agent: fakeAgent(),
                commandId,
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (chunk) => {
                    output.push(chunk);
                    return Promise.resolve();
                },
                prompt: text,
                resources: [],
                sessionId,
                signal,
            });
            return output.join("");
        };
        try {
            expect(await prompt("source-session", "source-command-1", "first")).toBe("Codex turn 1: first");
            expect(await prompt("source-session", "source-command-2", "second")).toBe("Codex turn 2: second");

            const selectedResponse = "Codex turn 1: first";
            const forked = await manager.forkSessionAtTurn(
                {
                    additionalDirectories: [],
                    agent: fakeAgent(),
                    cwd: temporaryDirectory,
                    sessionId: "forked-session",
                    signal,
                },
                "source-session",
                {
                    messageFingerprint: `sha256:${createHash("sha256").update(selectedResponse).digest("hex")}`,
                    messageId: "assistant-1",
                    messageOccurrence: 1,
                },
            );

            expect(forked.history).toMatchObject({
                status: "available",
                messages: [
                    expect.objectContaining({ role: "user", text: "first" }),
                    expect.objectContaining({ role: "assistant", text: selectedResponse }),
                ],
            });
            expect(JSON.stringify(forked.history)).not.toContain("second");
            expect(await prompt("forked-session", "forked-command", "after fork")).toBe("Codex turn 2: after fork");
        } finally {
            await manager.close();
            store.close();
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
        const manager = new AcpSessionManager(observer);
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
