import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { createAcpClient } from "../../src/acp/connection/create-client.ts";
import { CodexAcpAgent } from "../../src/acp/harness/codex/agent.ts";
import type { CodexSessionUpdate } from "../../src/acp/harness/codex/session-update.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";

test("Given an embedded image prompt, When Codex emits its user item, Then the image chunk does not duplicate its bytes in the URI", async () => {
    await using fixture = await ControlledCodexFixture.create();
    const updates: CodexSessionUpdate[] = [];
    const endpoint = new CodexAcpAgent({
        command: fixture.environment["MOBIUS_CODEX_PATH"] ?? "",
        cwd: process.cwd(),
        environment: fixture.environment,
        onSessionUpdate: async ({ update }) => {
            updates.push(update);
        },
    });
    const connection = createAcpClient({
        onUpdate: async () => undefined,
        onPermission: async () => {
            throw new Error("Unexpected permission request");
        },
        onElicitation: async () => {
            throw new Error("Unexpected input request");
        },
        onElicitationComplete: async () => undefined,
    }).connect(endpoint.app());
    const signal = AbortSignal.timeout(30_000);
    try {
        await endpoint.initialize(signal);
        await connection.agent.request(
            methods.agent.initialize,
            { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
            { cancellationSignal: signal },
        );
        const session = await connection.agent.request(
            methods.agent.session.new,
            { cwd: process.cwd(), mcpServers: [] },
            { cancellationSignal: signal },
        );
        const data = Buffer.alloc(800_000, 1).toString("base64");
        const resource = {
            type: "resource",
            resource: { uri: "morty://bot/instructions", mimeType: "text/plain", text: "Private bot instructions" },
        } satisfies import("@agentclientprotocol/sdk").ContentBlock;
        await connection.agent.request(
            methods.agent.session.prompt,
            { sessionId: session.sessionId, prompt: [{ type: "image", data, mimeType: "image/png" }, resource] },
            { cancellationSignal: signal },
        );
        const image = updates.find(
            (update) => update.sessionUpdate === "user_message_chunk" && update.content.type === "image",
        );
        expect(image).toMatchObject({ content: { type: "image", data, mimeType: "image/png" } });
        if (image?.sessionUpdate !== "user_message_chunk") {
            throw new Error("Missing user image chunk");
        }
        expect(image.content).not.toHaveProperty("uri");
        expect(updates).toContainEqual(
            expect.objectContaining({
                sessionUpdate: "user_message_chunk",
                messageId: image.messageId,
                content: resource,
            }),
        );
    } finally {
        await endpoint.close();
        connection.close();
    }
});
