import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeSessionEvent,
    encodeSessionElicitationRespondCommand,
    SESSION_EVENT_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/agent/specification/vendors/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { piQuestionExtension } from "../support/agents/pi-question-extension.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a connected Pi session, When the desktop terminal asks a question and a remote client answers, Then the same session continues and the terminal receives the answer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-local-question-"));
    try {
        const extensionPath = join(directory, "question.mjs");
        await writeFile(extensionPath, piQuestionExtension);
        const prompt = "Collect the answer before continuing";
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "SAME_SESSION_CONTINUED", {
            toolPrompt: prompt,
            toolSequence: [{ name: "collect_answer", input: '{"method":"input"}' }],
        });
        await using agent = await PiFixture.create(provider);
        await agent.overrideSettings({ extensions: [extensionPath] });
        await withRealDaemon(
            new PiAgentSpecification(),
            agent.environment,
            async (peer) => {
                const sessionId = await prepareNewRealSession(peer, "pi");
                const terminal = peer.command([
                    "chat",
                    "--runtime",
                    "runtime_real",
                    "--session",
                    sessionId,
                    "--prompt",
                    prompt,
                    "--json",
                ]);
                const remote = async (): Promise<void> => {
                    for (;;) {
                        const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                        if (
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "session.elicitation.requested"
                        ) {
                            expect(event.sessionId).toBe(sessionId);
                            peer.send(
                                encodeSessionElicitationRespondCommand({
                                    kind: "session.elicitation.respond",
                                    sessionId,
                                    interactionId: event.payload.event.interactionId,
                                    action: "accept",
                                    content: '{"answer":"answered from Morty"}',
                                }),
                            );
                        }
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                            expect(event.sessionId).toBe(sessionId);
                            expect(event.payload.stopReason).toBe("end_turn");
                            return;
                        }
                    }
                };
                await Promise.race([remote(), terminal.then(() => undefined)]);
                const output = await terminal;
                expect(output).toContain("answered from Morty");
                expect(output).toContain("SAME_SESSION_CONTINUED");
                expect(output).toContain("session.elicitation.resolved");
            },
            "managed",
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("Given a terminal disconnects while Pi is asking for input, When I reconnect and answer, Then the pending question is recovered and the original turn continues", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-local-reconnect-"));
    try {
        const extensionPath = join(directory, "question.mjs");
        await writeFile(extensionPath, piQuestionExtension);
        const prompt = "Collect the answer before continuing";
        await using provider = await FakeOpenAiProvider.start("gpt-4.1", "RECONNECTED_CONTINUED", {
            toolPrompt: prompt,
            toolSequence: [{ name: "collect_answer", input: '{"method":"input"}' }],
        });
        await using agent = await PiFixture.create(provider);
        await agent.overrideSettings({ extensions: [extensionPath] });
        await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
            const sessionId = await prepareNewRealSession(peer, "pi");
            const commandId = randomUUID();
            await using first = await peer.connectTerminal(sessionId);
            first.send({
                kind: "session.prompt",
                sessionId,
                commandId,
                agentId: "pi",
                bindingId: peer.bindingId,
                directoryId: first.session.directoryId,
                additionalDirectoryIds: [],
                disposition: SessionPromptDisposition.Reject,
                targetCommandId: "",
                prompt,
                images: [],
                resources: [],
            });
            let interactionId = "";
            for await (const message of first.messages) {
                if (message.kind !== SESSION_EVENT_KIND) {
                    continue;
                }
                const request = message.events.find(
                    (event) =>
                        event.type === "lifecycle-metadata" && event.payload.kind === "session.elicitation.requested",
                );
                if (
                    request?.type === "lifecycle-metadata" &&
                    request.payload.kind === "session.elicitation.requested"
                ) {
                    interactionId = request.payload.event.interactionId;
                    break;
                }
            }
            expect(interactionId).not.toBe("");
            first.close();
            await using reconnected = await peer.connectTerminal(sessionId);
            let recovered = false;
            let output = "";
            for await (const message of reconnected.messages) {
                if (message.kind === "native.session.result" && message.action === "active-turn") {
                    const question = message.turn?.interaction;
                    expect(question?.interactionId).toBe(interactionId);
                    expect(question?.commandId).toBe(commandId);
                    recovered = true;
                    reconnected.send({
                        kind: "session.elicitation.respond",
                        sessionId,
                        interactionId,
                        action: "accept",
                        content: '{"answer":"recovered answer"}',
                    });
                }
                if (message.kind !== SESSION_EVENT_KIND) {
                    continue;
                }
                output += JSON.stringify(message);
                if (
                    message.events.some(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === commandId,
                    )
                ) {
                    break;
                }
            }
            expect(recovered).toBe(true);
            expect(output).toContain("recovered answer");
            expect(output).toContain("RECONNECTED_CONTINUED");
            await using scoped = await peer.connectTerminal(sessionId);
            scoped.send({ kind: "session.cancel", sessionId: "another-session", commandId });
            await expect(
                (async () => {
                    for await (const _ of scoped.messages) {
                        /* Observe the rejection through the socket. */
                    }
                })(),
            ).rejects.toMatchObject({ code: "local_session_scope_mismatch" });
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
