import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { startProductionMobiusCli, startStandaloneDeployment } from "../../../e2e/support/standalone.ts";
import { discoverLocalAgentInventory } from "../../../packages/cli/src/agent-catalog/discover-local-agents.ts";
import {
    MobiusClient,
    MobiusPermissionResponseRequest,
    MobiusRecordingPolicy,
    MobiusTurnCompletedEvent,
    MobiusTurnFailedEvent,
    StaticMobiusCredentialProvider,
} from "../../../packages/mobius-sdk/src/server.ts";
import { CursorFixture } from "../infra/cursor.ts";
import { FakeCursorProvider } from "../providers/cursor.ts";

it("Given real Cursor CLI uses a local Cursor protocol provider, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using cursorProvider = await FakeCursorProvider.start();
    await using cursor = await CursorFixture.create(cursorProvider);
    await using deployment = await startStandaloneDeployment();
    const pairing = await deployment.createPairing(signal);
    await using daemon = await startProductionMobiusCli(deployment, pairing, {
        agentEnvironment: cursor.environment,
    });
    expect(daemon.channelId).toBe(pairing.channelId);

    const client = new MobiusClient({
        credentialProvider: new StaticMobiusCredentialProvider(pairing.hostToken),
        endpoint: deployment.origin,
        projectId: pairing.projectId,
    });
    let sessionId: string | undefined;
    try {
        try {
            await expect(client.runtimes.list(signal)).resolves.toEqual([
                expect.objectContaining({
                    agents: [
                        expect.objectContaining({
                            agentPath: cursor.executable,
                            agentVersion: expect.any(String),
                            id: "cursor",
                        }),
                    ],
                    online: true,
                    runtimeId: pairing.runtimeId,
                }),
            ]);
        } catch (error) {
            const diagnostics = await discoverLocalAgentInventory({
                defaultWorkspace: process.cwd(),
                environment: { ...process.env, ...cursor.environment },
                signal,
            });
            process.stderr.write(
                `Cursor CLI discovery diagnostics:\n${JSON.stringify(
                    diagnostics.unavailable.map(({ code, message, specification, status }) => ({
                        code,
                        id: specification.id,
                        message,
                        status,
                    })),
                    null,
                    2,
                )}\n`,
            );
            throw error;
        }
        const session = await client.sessions.create(
            {
                agentId: "cursor",
                bindingId: "workspace",
                directoryId: "default",
                policy: new MobiusRecordingPolicy("full", 86_400_000, 100, 100_000),
                runtimeId: pairing.runtimeId,
                sessionId: "real-cursor-local-provider",
                title: "Real Cursor local provider",
            },
            signal,
        );
        sessionId = session.sessionId;
        const completed = Promise.withResolvers<MobiusTurnCompletedEvent>();
        const subscription = await client.events.subscribe(
            session.sessionId,
            "",
            {
                receive: (event) => {
                    if (event.payload instanceof MobiusTurnCompletedEvent) {
                        completed.resolve(event.payload);
                    }
                    if (event.payload instanceof MobiusTurnFailedEvent) {
                        completed.reject(new Error(`${event.payload.code}: ${event.payload.message}`));
                    }
                    return Promise.resolve(true);
                },
            },
            signal,
        );
        try {
            await client.turns.submit(
                session.sessionId,
                {
                    additionalDirectoryIds: [],
                    artifactIds: [],
                    content: "Use a shell tool, then reply using the configured model",
                    idempotencyKey: "real-cursor-local-provider",
                    images: [],
                    resources: [],
                },
                signal,
            );
            await expect
                .poll(async () => (await client.interactions.listPending(session.sessionId, signal)).length, {
                    timeout: 20_000,
                })
                .toBe(1);
            const [permission] = await client.interactions.listPending(session.sessionId, signal);
            if (permission?.request.kind !== "permission") {
                throw new Error("Cursor CLI did not request tool permission");
            }
            const allow = permission.request.options.find((option) => option.kind === "allow_once");
            if (allow === undefined) {
                throw new Error("Cursor CLI did not offer one-time tool permission");
            }
            await client.interactions.respond(
                session.sessionId,
                permission.interactionId,
                new MobiusPermissionResponseRequest("agent-daemon-e2e", "selected", allow.optionId),
                signal,
            );
            await completed.promise;
        } finally {
            subscription.close();
            await subscription.completed;
        }

        await expect
            .poll(
                async () =>
                    (await client.sessions.readMessages(session.sessionId, { cursor: "", limit: 10 }, signal)).messages,
                { timeout: 10_000 },
            )
            .toMatchObject([
                {
                    attempt: { kind: "succeeded" },
                    activities: [
                        expect.objectContaining({
                            activityType: "tool",
                            status: "completed",
                            toolCallId: expect.any(String),
                        }),
                    ],
                    prompt: "Use a shell tool, then reply using the configured model",
                    response: expect.stringContaining(FakeCursorProvider.response),
                },
            ]);
    } catch (error) {
        const messages =
            sessionId === undefined
                ? []
                : (await client.sessions.readMessages(sessionId, { cursor: "", limit: 10 }, AbortSignal.timeout(5_000)))
                      .messages;
        process.stderr.write(
            `Cursor CLI integration diagnostics:\n${JSON.stringify(
                {
                    daemonOutput: daemon.output,
                    cursorStderr: await readFile(cursor.stderrPath, "utf8").catch(() => ""),
                    messages,
                    trace: { path: cursorProvider.tracePath, messages: cursorProvider.rawMessages().slice(-20) },
                },
                null,
                2,
            )}\n`,
        );
        throw error;
    } finally {
        client.close();
    }
});
