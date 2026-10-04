import { describe, expect, it } from "vitest";
import { AgentRuntimeManager } from "../../src/acp/agent-runtime-manager.ts";
import { LocalAgentDefinition } from "../../src/config.ts";
import { fakeAgentPath, RecordingObserver } from "./acp-feature-fixture.ts";

const usage = { cachedReadTokens: 200, inputTokens: 600, outputTokens: 200, thoughtTokens: 50, totalTokens: 1_000 };
const tokenCount = {
    cachedInputTokens: 200,
    inputTokens: 600,
    outputTokens: 200,
    reasoningOutputTokens: 50,
    totalTokens: 1_000,
};
const quota = { model_usage: [{ model: "test-model", token_count: tokenCount }], token_count: tokenCount };
const contextUsage = { used: 50_000, size: 200_000, cost: { amount: 0.125, currency: "USD" } };

function usageAgent(response: Readonly<Record<string, unknown>>, context?: typeof contextUsage): LocalAgentDefinition {
    return new LocalAgentDefinition("controlled-usage", "Controlled ACP", process.execPath, [fakeAgentPath], {
        MOBIUS_FAKE_ACP_PROMPT_RESPONSE: JSON.stringify(response),
        ...(context === undefined ? {} : { MOBIUS_FAKE_ACP_CONTEXT_USAGE: JSON.stringify(context) }),
    });
}

async function run(
    response: Readonly<Record<string, unknown>>,
    observer: RecordingObserver,
    context?: typeof contextUsage,
) {
    const manager = new AgentRuntimeManager(observer);
    try {
        return await manager.runPrompt({
            additionalDirectories: [],
            agent: usageAgent(response, context),
            commandId: "usage-command",
            cwd: process.cwd(),
            images: [],
            resources: [],
            sessionId: "usage-session",
            prompt: "Complete this turn",
            signal: AbortSignal.timeout(10_000),
            onActivity: async () => {},
            onText: async () => {},
        });
    } finally {
        await manager.close();
    }
}

describe("controlled ACP usage boundary", () => {
    it.each([
        { name: "absent usage", response: { stopReason: "end_turn", _meta: null, usage: null }, reportsUsage: false },
        {
            name: "unknown metadata",
            response: { stopReason: "end_turn", _meta: { privateData: "must not leave the ACP boundary" } },
            reportsUsage: false,
        },
        {
            name: "empty quota",
            response: { stopReason: "end_turn", _meta: { quota: { token_count: null, model_usage: [] } } },
            reportsUsage: true,
        },
        { name: "usage only", response: { stopReason: "end_turn", usage, _meta: null }, reportsUsage: true },
        { name: "quota only", response: { stopReason: "end_turn", usage: null, _meta: { quota } }, reportsUsage: true },
        { name: "cancelled usage", response: { stopReason: "cancelled", usage, _meta: { quota } }, reportsUsage: true },
    ])(
        "Given $name in a final response, When a prompt settles, Then only reported data is preserved without inventing context usage",
        async ({ response, reportsUsage }) => {
            const observer = new RecordingObserver();
            const result = await run(response, observer);
            expect(result.stopReason).toBe(response.stopReason);
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
        },
    );

    it.each([
        { name: "reasoning tokens", usage, tokenCount },
        {
            name: "cache write tokens",
            usage: { ...usage, cachedWriteTokens: 100, thoughtTokens: null, totalTokens: 1_100 },
            tokenCount: { ...tokenCount, cachedWriteTokens: 100, reasoningOutputTokens: 0, totalTokens: 1_100 },
        },
    ])(
        "Given $name in final usage, When a prompt completes, Then validated usage and quota coexist with independently reported context usage",
        async (scenario) => {
            const observer = new RecordingObserver();
            const expectedQuota = {
                model_usage: [{ model: "test-model", token_count: scenario.tokenCount }],
                token_count: scenario.tokenCount,
            };
            const result = await run(
                {
                    stopReason: "end_turn",
                    usage: scenario.usage,
                    _meta: { quota: expectedQuota, privateData: "must not leave the ACP boundary" },
                },
                observer,
                contextUsage,
            );
            expect(result).toMatchObject({
                stopReason: "end_turn",
                usage: scenario.usage,
                _meta: { quota: expectedQuota },
            });
            expect(JSON.stringify(result)).not.toContain("privateData");
            expect(observer.usage).toMatchObject([
                {
                    source: "context",
                    used: 50_000,
                    size: 200_000,
                    hasCost: true,
                    costAmount: 0.125,
                    costCurrency: "USD",
                },
                {
                    source: "prompt",
                    commandId: "usage-command",
                    usage: scenario.usage,
                    _meta: { quota: expectedQuota },
                },
            ]);
        },
    );

    it("Given snake-case quota metadata, When a prompt completes, Then the response succeeds with normalized bounded usage", async () => {
        const observer = new RecordingObserver();
        const tokens = { input_tokens: 600, output_tokens: 200 };
        const result = await run(
            {
                stopReason: "end_turn",
                _meta: { quota: { model_usage: [{ model: "test-model", token_count: tokens }], token_count: tokens } },
            },
            observer,
        );
        const expectedQuota = {
            model_usage: [
                { model: "test-model", token_count: { inputTokens: 600, outputTokens: 200, totalTokens: 800 } },
            ],
            token_count: { inputTokens: 600, outputTokens: 200, totalTokens: 800 },
        };
        expect(result).toMatchObject({ stopReason: "end_turn", _meta: { quota: expectedQuota } });
        expect(observer.usage).toMatchObject([
            { source: "prompt", commandId: "usage-command", usage: null, _meta: { quota: expectedQuota } },
        ]);
    });

    it.each([
        { name: "usage", response: { stopReason: "end_turn", usage: { ...usage, totalTokens: -1 } } },
        {
            name: "quota",
            response: {
                stopReason: "end_turn",
                _meta: { quota: { ...quota, token_count: { ...tokenCount, totalTokens: -1 } } },
            },
        },
    ])(
        "Given malformed final $name, When a prompt completes, Then invalid data is rejected with a sanitized typed failure",
        async ({ response }) => {
            const observer = new RecordingObserver();
            await expect(run(response, observer)).rejects.toMatchObject({
                code: "acp_invalid_prompt_response",
                message: "ACP agent returned an invalid prompt response",
            });
            expect(observer.usage).toEqual([]);
        },
    );
});
