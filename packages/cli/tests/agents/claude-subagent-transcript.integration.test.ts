import { randomUUID } from "node:crypto";
import {
    decodeSessionEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/agent-catalog/agents/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import type { RealDaemonPeer } from "../support/agents/real-daemon.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

/** The main-thread prompt that asks for a subagent dispatch. */
const DISPATCH_PROMPT = "Delegate the verification to a helper agent and then summarize";
/** The prompt handed to the spawned subagent. */
const INNER_PROMPT = "Use a shell tool successfully, then reply with your findings";
/** The subagent's final report text. */
const INNER_REPORT = "SUBAGENT_REPORT: shell verified";

test("Given Claude Code dispatches a subagent that runs tools, When the turn streams through the daemon, Then only the Agent call and its report surface", async () => {
    await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "CLAUDE_SUBAGENT_DONE", {
        subagent: {
            dispatchDescription: "Verify via helper",
            dispatchPrompt: DISPATCH_PROMPT,
            innerPrompt: INNER_PROMPT,
            innerReport: INNER_REPORT,
        },
    });
    await using agent = await ClaudeFixture.create(provider);
    await withRealDaemon(new ClaudeCodeAgentSpecification(), agent.environment, async (peer) => {
        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: peer.bindingId,
                commandId,
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: DISPATCH_PROMPT,
                resources: [],
                sessionId: peer.sessionId,
                targetCommandId: "",
            }),
        );
        const observed = await observeTurn(peer, commandId);
        // The subagent's only visible footprint is its dispatch call — refined
        // with the dispatch prompt once its input assembles — completed with the
        // harness's dispatch result. The doubled final answer proves the subagent
        // ran to completion and woke the main thread inside the turn, so its own
        // tool calls and text had every chance to surface — and none did.
        expect(observed.toolCalls.length).toBe(1);
        expect(observed.toolCalls[0]?.title).toBe("Verify via helper");
        expect(observed.toolCalls[0]?.rawInputContains).toContain(INNER_PROMPT);
        expect(observed.answerRepeats).toBe(2);
        expect(observed.completion?.stopReason).toBe("end_turn");
    });
});

interface ObservedToolCall {
    readonly rawInputContains: string;
    readonly title: string;
}

interface ObservedTurn {
    readonly toolCalls: readonly ObservedToolCall[];
    /** How many times the provider's answer text was delivered — once for the
     *  pre-wake reply and once for the post-wake continuation. */
    readonly answerRepeats: number;
    readonly completion: { stopReason: string } | undefined;
}

/** Drains the session event stream until the prompt settles, recording the
 *  latest surfaced tool call presentation (a tool_call and its refinements are
 *  one logical call), the answer deliveries, and the turn outcome — answering
 *  every permission request with its one-time allowance. */
async function observeTurn(peer: RealDaemonPeer, commandId: string): Promise<ObservedTurn> {
    const titles = new Map<string, string>();
    const rawInputs = new Map<string, unknown>();
    const toolStatus = new Map<string, string>();
    let answerRepeats = 0;
    let completion: { stopReason: string } | undefined;
    for (;;) {
        const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
        if (event.type !== "acp") {
            if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
                const option = event.payload.event.options.find((entry) => entry.kind === "allow_once");
                if (option === undefined) {
                    throw new Error("No one-time tool permission option");
                }
                peer.send(
                    encodeSessionPermissionRespondCommand({
                        interactionId: event.payload.event.interactionId,
                        kind: "session.permission.respond",
                        optionId: option.optionId,
                        outcome: "selected",
                        sessionId: peer.sessionId,
                    }),
                );
            } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                throw new Error(JSON.stringify(event));
            } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                expect(event.payload.commandId).toBe(commandId);
                completion = { stopReason: event.payload.stopReason };
                break;
            }
            continue;
        }
        const update = event.payload;
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            if (update.title !== null && update.title !== undefined) {
                titles.set(update.toolCallId, update.title);
            }
            if (update.rawInput !== undefined) {
                rawInputs.set(update.toolCallId, update.rawInput);
            }
            if (update.sessionUpdate === "tool_call_update") {
                const status = update.status ?? undefined;
                if (status !== undefined) {
                    toolStatus.set(update.toolCallId, status);
                }
            }
        } else if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text" &&
            update.content.text.includes("héllo 🌍")
        ) {
            answerRepeats += 1;
        }
    }
    const toolCalls: ObservedToolCall[] = [];
    for (const [identifier, title] of titles) {
        expect(toolStatus.get(identifier)).toBe("completed");
        toolCalls.push({
            rawInputContains: JSON.stringify(rawInputs.get(identifier) ?? null),
            title,
        });
    }
    return { answerRepeats, completion, toolCalls };
}
