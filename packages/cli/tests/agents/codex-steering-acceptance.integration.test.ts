import { methods, PROTOCOL_VERSION, type SessionUpdate } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { createAcpClient } from "../../src/acp/connection/create-client.ts";
import { CodexAcpAgent } from "../../src/acp/harness/codex/agent.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";

for (const terminal of ["cancelled", "completed", "failed"] as const) {
    test(`Given Codex defers accepted steering, When its turn is ${terminal} and the endpoint is reused, Then new steering retains its own content despite late old-turn input`, async () => {
        await using fixture = await ControlledCodexFixture.create({
            holdTurn: true,
            skipSecondSteering: true,
            consumeSteeringAfterFirstTurn: true,
            latePreviousUser: true,
            ...(terminal === "cancelled" ? {} : { endFirstTurnOnSteering: terminal }),
        });
        let started = Promise.withResolvers<void>();
        const updates: SessionUpdate[] = [];
        const consumed = Promise.withResolvers<void>();
        let userChunks = 0;
        const endpoint = new CodexAcpAgent({
            command: fixture.environment["MOBIUS_CODEX_PATH"] ?? "",
            cwd: process.cwd(),
            environment: fixture.environment,
            onSessionUpdate: async ({ update }) => {
                updates.push(update);
                if (
                    update.sessionUpdate === "user_message_chunk" &&
                    update.messageId === "controlled-steering-user-2"
                ) {
                    consumed.resolve();
                }
                if (update.sessionUpdate === "user_message_chunk") {
                    userChunks += 1;
                    if (update.messageId === "controlled-user-2") {
                        started.resolve();
                    }
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
            if (terminal === "cancelled") {
                await connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
            }
            await running.catch(() => undefined);
            started = Promise.withResolvers<void>();
            const reused = connection.agent.request(
                methods.agent.session.prompt,
                { sessionId: session.sessionId, prompt: [{ type: "text", text: "New turn" }] },
                { cancellationSignal: signal },
            );
            void reused.catch(() => {});
            await started.promise;
            expect(
                await connection.agent.request(
                    "_session/steering",
                    {
                        sessionId: session.sessionId,
                        prompt: [{ type: "text", text: "Rejected by the native submission hook" }],
                    },
                    { cancellationSignal: signal },
                ),
            ).toMatchObject({ outcome: "injected" });
            expect(
                await connection.agent.request(
                    "_session/steering",
                    {
                        sessionId: session.sessionId,
                        prompt: [
                            {
                                type: "resource",
                                resource: {
                                    uri: "morty://new-steering",
                                    text: "New requirement",
                                    mimeType: "text/plain",
                                },
                            },
                        ],
                    },
                    { cancellationSignal: signal },
                ),
            ).toMatchObject({ outcome: "injected" });
            await consumed.promise;
            expect(
                updates.filter(
                    (update) =>
                        update.sessionUpdate === "user_message_chunk" &&
                        update.messageId === "controlled-steering-user-2",
                ),
            ).toMatchObject([
                { content: { type: "resource", resource: { uri: "morty://new-steering", text: "New requirement" } } },
            ]);
            expect(
                updates.filter(
                    (update) =>
                        update.sessionUpdate === "user_message_chunk" && update.messageId === "controlled-user-2",
                ),
            ).toMatchObject([{ content: { type: "text", text: "New turn" } }]);
            await connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
            await reused;
        } finally {
            await endpoint.close();
            connection.close();
        }
    });
}
