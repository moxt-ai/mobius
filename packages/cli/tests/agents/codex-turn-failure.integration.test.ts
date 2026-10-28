import { methods, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { createAcpClient } from "../../src/engine/acp/connection/create-client.ts";
import { CodexAcpAgent } from "../../src/engine/acp/harness/codex/agent.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";

test("Given Codex fails a turn with a reason, When the prompt is rejected, Then the Codex reason and the user message identity reach the client", async () => {
    await using fixture = await ControlledCodexFixture.create({
        failTurnWith: "You've hit your usage limit. Try again later.",
    });
    const endpoint = new CodexAcpAgent({
        command: fixture.environment["MOBIUS_CODEX_PATH"] ?? "",
        cwd: process.cwd(),
        environment: fixture.environment,
        onSessionUpdate: async () => undefined,
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
        const failure = await connection.agent
            .request(
                methods.agent.session.prompt,
                { sessionId: session.sessionId, prompt: [{ type: "text", text: "Do the work" }] },
                { cancellationSignal: signal },
            )
            .then(
                () => null,
                (cause: unknown) => cause,
            );
        expect(failure).toBeInstanceOf(RequestError);
        expect(failure).toMatchObject({
            message: "Internal error: You've hit your usage limit. Try again later.",
            data: { messageId: "controlled-user-1" },
        });
    } finally {
        await endpoint.close();
        connection.close();
    }
});
