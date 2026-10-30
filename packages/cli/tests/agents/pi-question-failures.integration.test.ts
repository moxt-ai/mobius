import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, RequestError, type SessionNotification } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { PiFixture } from "../support/agents/pi.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

for (const operation of ["prompt", "compact"] as const) {
    for (const failure of operation === "prompt" ? ["request", "response", "cancel"] : ["request", "response"]) {
        test(`Given real Pi asks during ${operation}, When its host callback returns ${failure}, Then the operation distinguishes cancellation from failure without leaking client details and a follow-up succeeds`, async () => {
            const prompt = "Ask a native question";
            await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_AFTER_FAILURE", {
                toolPrompt: prompt,
                toolSequence: [{ name: "ask_one", input: "{}" }],
            });
            await using agent = await PiFixture.create(provider);
            await agent.overrideSettings({ compaction: { keepRecentTokens: 1 } });
            await agent.installExtension(
                "failure-questions.js",
                `export default function (pi) {
                    pi.registerTool({ name: "ask_one", label: "Ask", description: "Ask a question",
                        parameters: { type: "object", properties: {} },
                        async execute(_id, _params, _signal, _update, ctx) {
                            const answer = await ctx.ui.select("Choose", ["One", "Two"]);
                            return { content: [{ type: "text", text: JSON.stringify(answer ?? null) }], details: {} };
                        },
                    });
                    pi.on("session_before_compact", async (event, ctx) => {
                        await ctx.ui.select("Compact", ["One", "Two"]);
                        // Cooperate with native cancellation without vetoing compaction ourselves.
                        if (!event.signal.aborted) {
                            await new Promise(resolve => event.signal.addEventListener("abort", resolve, { once: true }));
                        }
                        ctx.ui.notify("PI_NATIVE_COMPACTION_STOPPED", "info");
                    });
                }`,
            );
            const workspace = await mkdtemp(join(tmpdir(), "mobius-pi-question-failure-"));
            const updates: SessionNotification[] = [];
            let requests = 0;
            const client = agent.createClient({
                requestElicitation: async () => {
                    requests += 1;
                    if (requests > 1) {
                        return { action: "accept", content: { value: "One" } };
                    }
                    if (failure === "request") {
                        throw RequestError.internalError({
                            details: "PRIVATE_CLIENT_FAILURE",
                            code: "client_unavailable",
                        });
                    }
                    if (failure === "cancel") {
                        throw RequestError.requestCancelled();
                    }
                    return { action: "accept", content: { value: "NOT_AN_OPTION" } };
                },
                startUserMessage: () => undefined,
                requestPermission: async () => {
                    throw new Error("A Pi question is not a permission request");
                },
                sessionUpdate: async (update) => {
                    updates.push(update);
                },
            });
            try {
                await client.initialize({
                    clientCapabilities: { elicitation: { form: {} } },
                    protocolVersion: PROTOCOL_VERSION,
                });
                const session = await client.newSession({
                    cwd: workspace,
                    mcpServers: [],
                });
                const send = (text: string) =>
                    client.prompt({
                        sessionId: session.sessionId,
                        prompt: [{ type: "text", text }],
                    });
                if (operation === "compact") {
                    for (const topic of ["archaeology", "bicycles", "coffee"]) {
                        await send(`Talk about ${topic}`);
                    }
                }
                const failed = send(operation === "compact" ? "/compact" : prompt);
                if (failure === "cancel") {
                    expect(await failed).toEqual({ stopReason: "end_turn" });
                    expect(JSON.stringify(updates)).not.toContain("Pi could not");
                    expect(JSON.stringify(updates)).not.toContain("timed out");
                } else {
                    await expect(failed).rejects.toMatchObject({
                        code: -32603,
                        data: {
                            code: failure === "request" ? "pi_question_request_failed" : "pi_question_invalid_response",
                            details:
                                failure === "request"
                                    ? "Pi could not request an answer."
                                    : "Pi received an invalid answer.",
                        },
                    });
                }
                expect(JSON.stringify(updates)).not.toContain("PRIVATE_CLIENT_FAILURE");
                if (operation === "compact") {
                    expect(JSON.stringify(updates)).toContain("PI_NATIVE_COMPACTION_STOPPED");
                    expect(
                        updates.some(
                            ({ update }) => update.sessionUpdate === "compaction_update" && update.status === "failed",
                        ),
                    ).toBe(true);
                }
                expect(await send("Continue after the failed question")).toEqual({ stopReason: "end_turn" });
                expect(requests).toBe(1);
            } finally {
                await client.dispose();
                await rm(workspace, { recursive: true, force: true });
            }
        });
    }
}
