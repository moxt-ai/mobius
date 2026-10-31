import { addAbortListener } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { z } from "zod";
import { createAcpClient } from "../../src/engine/acp/connection/create-client.ts";
import { type ClaudeSessionUpdate, createClaudeAcpApp } from "../../src/engine/acp/harness/claude/upstream/dist/lib.js";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";

test("Given real Claude streams a message, When its harness emits chunks and replays history, Then each message has a required messageId", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "CLAUDE_IDENTITY_REPLY");
    await using fixture = await ClaudeFixture.create(provider);
    const cwd = await mkdtemp(join(tmpdir(), "mobius-claude-message-identity-"));
    const updates: ClaudeSessionUpdate[] = [];
    const followUp = "A new prompt from idle steering";
    const submittedFollowUp = Promise.withResolvers<string>();
    const environment = { ...process.env, ...fixture.environment, CLAUDE_CODE_EXECUTABLE: fixture.executable };
    const claude = createClaudeAcpApp({
        environment,
        onSessionUpdate: async ({ sessionId, update }) => {
            updates.push(update);
            if (
                update.sessionUpdate === "user_message_chunk" &&
                update.content.type === "text" &&
                update.content.text === "Cancel during echo"
            ) {
                await connection.agent.notify(methods.agent.session.cancel, { sessionId });
                await connection.agent.request(methods.agent.session.list, {}, { cancellationSignal: signal });
            }
            if (
                update.sessionUpdate === "user_message_chunk" &&
                update.content.type === "text" &&
                update.content.text === followUp
            ) {
                submittedFollowUp.resolve(update.messageId);
            }
        },
    });
    const connection = createAcpClient({
        onUpdate: async () => undefined,
        onPermission: async () => {
            throw new Error("The identity scenario must not request permission");
        },
        onElicitation: async () => {
            throw new Error("The identity scenario must not request input");
        },
        onElicitationComplete: async () => undefined,
    }).connect(claude.app);
    const signal = AbortSignal.timeout(60_000);
    try {
        await connection.agent.request(
            methods.agent.initialize,
            { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
            { cancellationSignal: signal },
        );
        const { sessionId } = await connection.agent.request(
            methods.agent.session.new,
            { cwd, mcpServers: [] },
            { cancellationSignal: signal },
        );
        const result = await connection.agent.request(
            methods.agent.session.prompt,
            { sessionId, prompt: [{ type: "text", text: fakeProviderPrompts.streamedTool }] },
            { cancellationSignal: signal },
        );
        const userMessages = updates.filter((update) => update.sessionUpdate === "user_message_chunk");
        expect(userMessages).toHaveLength(1);
        expect(userMessages[0]?.messageId).toEqual(expect.any(String));
        expect(result._meta?.["messageId"]).toBe(userMessages[0]?.messageId);
        const messages = updates.filter((update) => update.sessionUpdate === "agent_message_chunk");
        expect(messages.length).toBeGreaterThan(1);
        expect(
            messages.flatMap((update) => (update.content.type === "text" ? [update.content.text] : [])).join(""),
        ).toContain(provider.response);
        expect(new Set(messages.map((update) => update.messageId)).size).toBe(1);
        for (const update of messages) {
            expect(update.messageId).toEqual(expect.any(String));
        }
        updates.length = 0;
        expect(
            await connection.agent.request(
                methods.agent.session.prompt,
                {
                    sessionId,
                    prompt: [
                        { type: "text", text: "Cancel during echo" },
                        { type: "text", text: "Do not submit this turn" },
                    ],
                },
                { cancellationSignal: signal },
            ),
        ).toMatchObject({ stopReason: "cancelled" });
        await connection.agent.request(
            methods.agent.session.load,
            { sessionId, cwd, mcpServers: [] },
            { cancellationSignal: signal },
        );
        const replay = updates.filter(
            (update) =>
                update.sessionUpdate === "agent_message_chunk" ||
                update.sessionUpdate === "user_message_chunk" ||
                update.sessionUpdate === "agent_thought_chunk",
        );
        expect(replay.length).toBeGreaterThan(0);
        for (const update of replay) {
            expect(update.messageId).toEqual(expect.any(String));
        }
        expect(
            replay.filter((update) => update.sessionUpdate === "user_message_chunk").map((update) => update.messageId),
        ).toContain(userMessages[0]?.messageId);
        const steering = z
            .object({ outcome: z.literal("startedNewTurn"), messageId: z.string().min(1) })
            .parse(
                await connection.agent.request(
                    "_session/steering",
                    { sessionId, prompt: [{ type: "text", text: followUp }] },
                    { cancellationSignal: signal },
                ),
            );
        using _listener = addAbortListener(signal, () => {
            submittedFollowUp.reject(signal.reason);
        });
        expect(await submittedFollowUp.promise).toBe(steering.messageId);
        // A subsequent completed prompt establishes that Claude processed the detached input.
        const confirmation = await connection.agent.request(
            methods.agent.session.prompt,
            { sessionId, prompt: [{ type: "text", text: "Finish with a short confirmation" }] },
            { cancellationSignal: signal },
        );
        expect(confirmation.stopReason).toBe("end_turn");
        // A completed prompt does not mean Claude saved the detached input; wait for its native write.
        const saved = await fixture.waitForSavedMessage(sessionId, steering.messageId, signal);
        expect(saved.filter((message) => message.type === "user")).toEqual(
            expect.arrayContaining([expect.objectContaining({ uuid: steering.messageId })]),
        );
    } finally {
        await claude.agent()?.dispose();
        connection.close();
        await rm(cwd, { recursive: true, force: true });
    }
});
