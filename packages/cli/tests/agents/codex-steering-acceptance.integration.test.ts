import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { createAcpClient } from "../../src/acp/connection/create-client.ts";
import { CodexAcpAgent } from "../../src/acp/harness/codex/agent.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";

test("Given Codex defers consuming accepted steering, When the user steers the running turn, Then acceptance does not wait for another native user item", async () => {
    await using fixture = await ControlledCodexFixture.create({ holdTurn: true });
    const started = Promise.withResolvers<void>();
    let userChunks = 0;
    const endpoint = new CodexAcpAgent({
        command: fixture.environment["MOBIUS_CODEX_PATH"] ?? "",
        cwd: process.cwd(),
        environment: fixture.environment,
        onSessionUpdate: async ({ update }) => {
            if (update.sessionUpdate === "user_message_chunk") {
                userChunks += 1;
            }
            if (userChunks > 0 && update.sessionUpdate === "config_option_update") {
                started.resolve();
            }
        },
    });
    const rejectInteraction = async (): Promise<never> => {
        throw new Error("Unexpected interaction");
    };
    const connection = createAcpClient({
        onUpdate: async () => undefined,
        onPermission: rejectInteraction,
        onElicitation: rejectInteraction,
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
        const running = connection.agent.request(
            methods.agent.session.prompt,
            { sessionId: session.sessionId, prompt: [{ type: "text", text: "Hold the turn" }] },
            { cancellationSignal: signal },
        );
        void running.catch(() => {});
        await started.promise;
        const response = await connection.agent.request(
            "_session/steering",
            { sessionId: session.sessionId, prompt: [{ type: "text", text: "Use the new requirement" }] },
            { cancellationSignal: signal },
        );
        expect(response).toMatchObject({ outcome: "injected" });
        expect(userChunks).toBe(1);
        await connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
        await running;
    } finally {
        await endpoint.close();
        connection.close();
    }
});
