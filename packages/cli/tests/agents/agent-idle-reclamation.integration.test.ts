import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeSessionEvent,
    encodeSessionHistoryPageLoad,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/agent/specification/vendors/codex-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { waitForAgentFile, writeObservedAgentLauncher } from "../support/agents/observed-process.ts";
import { prepareNewRealSession, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { IdleTimeoutTimer } from "../support/idle-timeout-timer.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

afterEach(() => vi.useRealTimers());

test.each(["codex", "claude"] as const)(
    "Given a real %s conversation, When it is reclaimed after two idle hours, Then its process exits and its original history continues in a new process",
    async (agentId) => {
        await using provider =
            agentId === "codex"
                ? await FakeOpenAiProvider.start("mobius-test-model", "IDLE_RECOVERY_REPLY")
                : await FakeAnthropicProvider.start("claude-sonnet-4-6", "IDLE_RECOVERY_REPLY");
        await using agent =
            provider instanceof FakeOpenAiProvider
                ? await CodexFixture.create(provider)
                : await ClaudeFixture.create(provider);
        const directory = await mkdtemp(join(tmpdir(), `mobius-idle-real-${agentId}-`));
        const processes = join(directory, "processes");
        const launcher = join(directory, "agent.mjs");
        await mkdir(processes);
        await writeObservedAgentLauncher(agent.executable, launcher, processes);
        const timer = new IdleTimeoutTimer();
        vi.useFakeTimers({ now: new Date("2026-10-22T00:00:00Z"), toFake: ["Date"] });
        try {
            await withRealDaemon(
                agentId === "codex" ? new CodexAgentSpecification() : new ClaudeCodeAgentSpecification(),
                { ...agent.environment, [agentId === "codex" ? "MOBIUS_CODEX_PATH" : "MOBIUS_CLAUDE_PATH"]: launcher },
                async (peer) => {
                    const sessionId = await prepareNewRealSession(peer, agentId);
                    await prompt(peer, agentId, sessionId, "Remember ORIGINAL_BEFORE_IDLE and reply without tools");
                    const retained = (await readdir(processes)).filter((name) => name.endsWith(".process"));
                    expect(retained).toHaveLength(1);
                    const original = retained[0];
                    if (original === undefined) {
                        throw new Error("The real Agent process was not retained");
                    }
                    timer.advance(2 * 60 * 60 * 1_000 - 1);
                    expect(existsSync(join(processes, original))).toBe(true);
                    const exited = waitForAgentFile(join(processes, original), false);
                    timer.advance(1);
                    await exited;
                    await prompt(peer, agentId, sessionId, "Continue AFTER_IDLE_RECOVERY without tools");
                    const resumed = (await readdir(processes)).filter((name) => name.endsWith(".process"));
                    expect(resumed).toHaveLength(1);
                    expect(resumed[0]).not.toBe(original);
                    peer.send(
                        encodeSessionHistoryPageLoad({
                            kind: "session.live-history.v2.page.load",
                            requestId: crypto.randomUUID(),
                            sessionId,
                            cursor: null,
                            eventLimit: 200,
                        }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        const kind = decodeMessageKind(message);
                        if (kind === "session.operation.failed" || kind === "session.close.notice") {
                            throw new Error(message);
                        }
                        if (kind === "session.live-history.v2.page.loaded") {
                            expect(message).toContain("ORIGINAL_BEFORE_IDLE");
                            expect(message).toContain("AFTER_IDLE_RECOVERY");
                            break;
                        }
                    }
                },
                "embedded",
                undefined,
                timer,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

async function prompt(peer: RealDaemonPeer, agentId: string, sessionId: string, text: string): Promise<void> {
    const commandId = crypto.randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            kind: "session.prompt",
            commandId,
            sessionId,
            agentId,
            bindingId: peer.bindingId,
            directoryId: "default",
            additionalDirectoryIds: [],
            images: [],
            resources: [],
            prompt: text,
            disposition: SessionPromptDisposition.Reject,
            targetCommandId: "",
        }),
    );
    let output = "";
    for (;;) {
        const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
        if (
            event.type === "acp" &&
            event.payload.sessionUpdate === "agent_message_chunk" &&
            event.payload.content.type === "text"
        ) {
            output += event.payload.content.text;
        }
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
            throw new Error(JSON.stringify(event));
        }
        if (
            event.type === "lifecycle-metadata" &&
            event.payload.kind === "prompt.completed" &&
            event.payload.commandId === commandId
        ) {
            expect(event.payload.stopReason).toBe("end_turn");
            expect(output).toContain("IDLE_RECOVERY_REPLY");
            return;
        }
    }
}
