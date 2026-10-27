import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, PROTOCOL_VERSION, type SessionUpdate } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { createAcpClient } from "../../src/acp/connection/create-client.ts";
import { PiAcpEndpoint } from "../../src/acp/harness/pi/endpoint.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given real Pi streams multiple messages, When the harness emits chunks, replays history and exports a session, Then each message has one messageId and no nativeMessageId", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_IDENTITY_REPLY");
    await using fixture = await PiFixture.create(provider);
    const cwd = await mkdtemp(join(tmpdir(), "mobius-pi-message-identity-"));
    const updates: SessionUpdate[] = [];
    const endpoint = new PiAcpEndpoint({
        command: fixture.executable,
        environment: fixture.environment,
        cwd,
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
    }).connect(endpoint.app());
    const signal = AbortSignal.timeout(60_000);
    try {
        await endpoint.initialize(signal);
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
        const ids = new Set<string>();
        for (const prompt of [
            "Stream a short greeting, without tools",
            "Stream another short greeting, without tools",
        ]) {
            updates.length = 0;
            await connection.agent.request(
                methods.agent.session.prompt,
                { sessionId, prompt: [{ type: "text", text: prompt }] },
                { cancellationSignal: signal },
            );
            const messages = updates.filter((update) => update.sessionUpdate === "agent_message_chunk");
            expect(messages.length).toBeGreaterThan(1);
            expect(
                messages.flatMap((update) => (update.content.type === "text" ? [update.content.text] : [])).join(""),
            ).toContain(provider.response);
            const messageIds = new Set(messages.map((update) => update.messageId));
            expect(messageIds.size).toBe(1);
            for (const update of messages) {
                const id = update.messageId;
                if (typeof id !== "string" || id.length === 0) {
                    throw new Error("Pi did not identify its message");
                }
                expect(ids.has(id)).toBe(false);
                expect(Object.hasOwn(update, "nativeMessageId")).toBe(false);
            }
            for (const id of messageIds) {
                if (typeof id === "string") {
                    ids.add(id);
                }
            }
        }
        updates.length = 0;
        await connection.agent.request(
            methods.agent.session.prompt,
            { sessionId, prompt: [{ type: "text", text: "/export" }] },
            { cancellationSignal: signal },
        );
        const exported = updates.filter((update) => update.sessionUpdate === "agent_message_chunk");
        expect(exported.map((update) => update.content.type)).toEqual(["text", "resource_link"]);
        expect(new Set(exported.map((update) => update.messageId)).size).toBe(1);
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
            expect(Object.hasOwn(update, "nativeMessageId")).toBe(false);
        }
    } finally {
        await endpoint.close();
        connection.close();
        await rm(cwd, { recursive: true, force: true });
    }
});
