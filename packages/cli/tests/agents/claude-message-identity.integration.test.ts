import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { createAcpClient } from "../../src/acp/connection/create-client.ts";
import { type ClaudeSessionUpdate, createClaudeAcpApp } from "../../src/acp/harness/claude/upstream/dist/lib.js";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test("Given real Claude streams a message, When its harness emits chunks and replays history, Then each message has harness and native identities", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "CLAUDE_IDENTITY_REPLY");
    await using fixture = await ClaudeFixture.create(provider);
    const cwd = await mkdtemp(join(tmpdir(), "mobius-claude-message-identity-"));
    const updates: ClaudeSessionUpdate[] = [];
    const claude = createClaudeAcpApp({
        environment: { ...process.env, ...fixture.environment, CLAUDE_CODE_EXECUTABLE: fixture.executable },
        onSessionUpdate: async ({ update }) => {
            updates.push(update);
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
        await connection.agent.request(
            methods.agent.session.prompt,
            { sessionId, prompt: [{ type: "text", text: "Stream a short greeting, without tools" }] },
            { cancellationSignal: signal },
        );
        const messages = updates.filter((update) => update.sessionUpdate === "agent_message_chunk");
        expect(messages.length).toBeGreaterThan(1);
        expect(
            messages.flatMap((update) => (update.content.type === "text" ? [update.content.text] : [])).join(""),
        ).toContain(provider.response);
        expect(new Set(messages.map((update) => update.messageId)).size).toBe(1);
        for (const update of messages) {
            expect(update.messageId).toEqual(expect.any(String));
            expect(update.nativeMessageId).toEqual(expect.any(String));
            expect(update.nativeMessageId).not.toBe(update.messageId);
        }
        updates.length = 0;
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
            expect(update.nativeMessageId).toEqual(expect.any(String));
        }
    } finally {
        await claude.agent()?.dispose();
        connection.close();
        await rm(cwd, { recursive: true, force: true });
    }
});
