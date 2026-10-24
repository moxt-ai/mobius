import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    type SessionLiveEvent,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/agent/specification/vendors/codex-agent.ts";
import { PiAgentSpecification } from "../../src/agent/specification/vendors/pi-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

for (const agentId of ["codex", "claude", "pi"] as const) {
    test(`Given real ${agentId} is answering, When a client loads history before and after its reply, Then each snapshot identifies the live events it covers`, async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let holdResponse = false;
        const options = {
            beforeFirstText: async () => {
                if (holdResponse) {
                    entered.resolve();
                    await release.promise;
                }
            },
        };
        const answer = "SNAPSHOT_POSITION_REPLY";
        const provider =
            agentId === "claude"
                ? await FakeAnthropicProvider.start("claude-sonnet-4-6", answer, options)
                : await FakeOpenAiProvider.start(agentId === "pi" ? "gpt-4.1" : "mobius-test-model", answer, options);
        const agent =
            provider instanceof FakeAnthropicProvider
                ? await ClaudeFixture.create(provider)
                : agentId === "pi"
                  ? await PiFixture.create(provider)
                  : await CodexFixture.create(provider);
        const specification =
            agentId === "claude"
                ? new ClaudeCodeAgentSpecification()
                : agentId === "pi"
                  ? new PiAgentSpecification()
                  : new CodexAgentSpecification();
        try {
            await withRealDaemon(specification, agent.environment, async (peer) => {
                const sessionId = await prepareNewRealSession(peer, agentId);
                holdResponse = true;
                const observed: SessionLiveEvent[] = [];
                const readPage = async (limit: number, cursor: string | null = null) => {
                    const requestId = randomUUID();
                    peer.send(
                        encodeSessionHistoryPageLoad({
                            kind: "session.live-history.v2.page.load",
                            requestId,
                            sessionId,
                            eventLimit: limit,
                            cursor,
                        }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        const kind = decodeMessageKind(message);
                        if (kind === "session.event.v2") {
                            observed.push(...decodeSessionEventEnvelope(message).events);
                        }
                        if (kind === "session.operation.failed") {
                            throw new Error(message);
                        }
                        if (kind === "session.live-history.v2.page.loaded") {
                            const loaded = decodeSessionHistoryPageLoaded(message);
                            if (loaded.requestId === requestId) {
                                return loaded.events.events;
                            }
                        }
                    }
                };
                const commandId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        sessionId,
                        commandId,
                        agentId,
                        bindingId: peer.bindingId,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                        prompt: "Reply with the requested answer.",
                        images: [],
                        resources: [],
                        disposition: SessionPromptDisposition.Reject,
                        targetCommandId: "",
                    }),
                );
                await entered.promise;
                const before = await readPage(1000);
                expect(before).toHaveProperty("throughPosition");
                if (before.throughPosition === undefined) {
                    throw new Error("Missing snapshot position");
                }
                const beforePosition = BigInt(before.throughPosition);
                expect(observed.every((event) => BigInt(event.position) <= beforePosition)).toBe(true);
                release.resolve();
                while (
                    !observed.some(
                        (event) =>
                            event.type === "lifecycle-metadata" &&
                            event.payload.kind === "prompt.completed" &&
                            event.payload.commandId === commandId,
                    )
                ) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) === "session.event.v2") {
                        const events = decodeSessionEventEnvelope(message).events;
                        expect(
                            events.filter(
                                (event) =>
                                    event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed",
                            ),
                        ).toEqual([]);
                        observed.push(...events);
                    }
                }
                const after = await readPage(1000);
                expect(after).toHaveProperty("throughPosition");
                if (after.throughPosition === undefined) {
                    throw new Error("Missing snapshot position");
                }
                const afterPosition = BigInt(after.throughPosition);
                expect(afterPosition).toBeGreaterThan(beforePosition);
                expect(observed.every((event) => BigInt(event.position) <= afterPosition)).toBe(true);
                const replyEvents = observed.filter(
                    (event) => event.type === "acp" && event.payload.sessionUpdate === "agent_message_chunk",
                );
                expect(replyEvents.length).toBeGreaterThan(0);
                expect(replyEvents.every((event) => BigInt(event.position) > beforePosition)).toBe(true);
                expect(after.sessionGenerationId).toBe(before.sessionGenerationId);
                const text = after.events
                    .flatMap((event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "agent_message_chunk" &&
                        event.payload.content.type === "text"
                            ? [event.payload.content.text]
                            : [],
                    )
                    .join("");
                expect(text).toContain(answer);
                const page = await readPage(1);
                expect(page).toHaveProperty("throughPosition");
                expect(page.throughPosition).toBe(after.throughPosition);
                expect(page.events).toHaveLength(1);
                expect(page.nextCursor).not.toBeNull();
            });
        } finally {
            release.resolve();
            await agent[Symbol.asyncDispose]();
            await provider[Symbol.asyncDispose]();
        }
    });
}
