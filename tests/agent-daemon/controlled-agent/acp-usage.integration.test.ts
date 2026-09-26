import { describe, expect, it } from "vitest";
import { AgentRuntimeManager } from "../../../packages/cli/src/acp/agent-runtime-manager.ts";

import { fakeAgent, RecordingObserver } from "./acp-feature-fixture.ts";

describe("acp usage", () => {
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
            const manager = new AgentRuntimeManager(observer);
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
            const manager = new AgentRuntimeManager(observer);
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
        const manager = new AgentRuntimeManager(observer);
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
            const manager = new AgentRuntimeManager(observer);
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
});
