import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    decodeSessionReadyEvent,
    encodeNativeSessionCommand,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/engine/agent/specification/vendors/claude-code-agent.ts";
import { CodexAgentSpecification } from "../../src/engine/agent/specification/vendors/codex-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

const toolPrompt = "Run the permission verification command";
const command = `node -e "require('node:fs').writeFileSync('fork-permission.txt', 'approved')"`;

test.each(["codex", "claude"] as const)(
    "Given a real %s Session with explicit approval, When it is forked before and after restart, Then each child retains approval and enforces the user's decision",
    async (agentId) => {
        await using provider =
            agentId === "codex"
                ? await FakeOpenAiProvider.start("mobius-test-model", "FORK_PERMISSION_DONE", {
                      toolPrompt,
                      toolSequence: [
                          {
                              name: "exec",
                              input: `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)}, sandbox_permissions: "require_escalated", justification: "Verify inherited Fork approval" }); text(result.output);`,
                          },
                      ],
                  })
                : await FakeAnthropicProvider.start("claude-sonnet-4-6", "FORK_PERMISSION_DONE", {
                      toolPrompt,
                      bash: { command, runInBackground: false },
                  });
        await using agent =
            provider instanceof FakeOpenAiProvider
                ? await CodexFixture.create(provider)
                : await ClaudeFixture.create(provider);
        if (agentId === "claude") {
            const config = agent.environment["CLAUDE_CONFIG_DIR"];
            if (config === undefined) {
                throw new Error("Missing Claude fixture home");
            }
            await mkdir(config, { recursive: true });
            await writeFile(
                join(config, "settings.json"),
                JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
            );
        }
        const mode = agentId === "codex" ? "read-only" : "default";
        await withRealDaemon(
            agentId === "codex" ? new CodexAgentSpecification() : new ClaudeCodeAgentSpecification(),
            agent.environment,
            async (peer) => {
                const identity = {
                    additionalDirectoryIds: [],
                    agentId,
                    bindingId: peer.bindingId,
                    directoryId: "default",
                };
                const prompt = (sessionId: string, text: string, selectMode = false): void =>
                    peer.send(
                        encodeSessionPromptCommand({
                            ...identity,
                            kind: "session.prompt",
                            sessionId,
                            commandId: randomUUID(),
                            disposition: SessionPromptDisposition.Reject,
                            attachments: [],
                            prompt: text,
                            targetCommandId: "",
                            ...(selectMode
                                ? {
                                      sessionConfigurations: [
                                          { configId: "mode", valueType: "select", value: mode, booleanValue: false },
                                      ],
                                  }
                                : {}),
                        }),
                    );
                const ready = async (sessionId: string): Promise<void> => {
                    const requestId = randomUUID();
                    peer.send(
                        encodeSessionPrepareCommand({ ...identity, kind: "session.prepare", requestId, sessionId }),
                    );
                    for (;;) {
                        const message = await peer.nextMessage();
                        const kind = decodeMessageKind(message);
                        if (kind === "session.operation.failed") {
                            throw new Error(message);
                        }
                        if (kind !== "session.ready") {
                            continue;
                        }
                        const result = decodeSessionReadyEvent(message);
                        if (result.requestId !== requestId) {
                            continue;
                        }
                        expect(result.configOptions).toContainEqual(
                            expect.objectContaining({ id: "mode", currentValue: mode }),
                        );
                        return;
                    }
                };
                prompt(peer.sessionId, "Remember this source conversation", true);
                expect(await finish(peer, "reject_once")).toBe(0);
                await ready(peer.sessionId);
                for (const decision of ["reject_once", "allow_once"] as const) {
                    if (decision === "allow_once") {
                        await peer.restart();
                    }
                    const listId = randomUUID();
                    peer.send(
                        encodeNativeSessionCommand({
                            ...identity,
                            kind: "native.session.request",
                            sessionId: peer.sessionId,
                            requestId: listId,
                            action: "list",
                            cursor: null,
                        }),
                    );
                    const listed = await nativeResult(peer, listId);
                    if (listed.action !== "list") {
                        throw new Error("Expected native session list");
                    }
                    const source = listed.entries.find((entry) => entry.mobiusSessionIds.includes(peer.sessionId));
                    if (source === undefined) {
                        throw new Error("Missing source Session");
                    }
                    const requestId = randomUUID();
                    const childId = randomUUID();
                    peer.send(
                        encodeNativeSessionCommand({
                            ...identity,
                            kind: "native.session.request",
                            sessionId: peer.sessionId,
                            requestId,
                            action: "fork",
                            entryId: source.entryId,
                            targetSessionId: childId,
                        }),
                    );
                    const fork = await nativeResult(peer, requestId);
                    if (fork.action !== "fork") {
                        throw new Error("Expected independent Fork");
                    }
                    expect(fork.ready.configOptions).toContainEqual(
                        expect.objectContaining({ id: "mode", currentValue: mode }),
                    );
                    expect(fork.ready.sessionId).toBe(childId);
                    if (decision === "allow_once") {
                        await peer.restart();
                    }
                    await ready(childId);
                    prompt(childId, toolPrompt);
                    expect(await finish(peer, decision)).toBe(1);
                    const file = join(peer.workspace, "fork-permission.txt");
                    if (decision === "allow_once") {
                        expect(await readFile(file, "utf8")).toBe("approved");
                        await rm(file);
                    } else {
                        await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
                    }
                    await ready(peer.sessionId);
                }
            },
        );
    },
);

async function nativeResult(peer: RealDaemonPeer, requestId: string) {
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.operation.failed") {
            throw new Error(message);
        }
        if (kind !== "native.session.result") {
            continue;
        }
        const result = decodeNativeSessionResult(message);
        if (result.requestId === requestId) {
            return result;
        }
    }
}

async function finish(peer: RealDaemonPeer, decision: "allow_once" | "reject_once"): Promise<number> {
    let approvals = 0;
    let text = "";
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (event.type === "lifecycle-metadata" && event.payload.kind === "session.permission.requested") {
            approvals++;
            const permission = event.payload.event;
            const choice = permission.options.find((option) => option.kind === decision);
            if (choice === undefined) {
                throw new Error(`Missing ${decision} approval choice`);
            }
            peer.send(
                encodeSessionPermissionRespondCommand({
                    kind: "session.permission.respond",
                    sessionId: event.sessionId,
                    interactionId: permission.interactionId,
                    optionId: choice.optionId,
                    outcome: "selected",
                }),
            );
        } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
            throw new Error(JSON.stringify(event));
        } else if (
            event.type === "acp" &&
            event.payload.sessionUpdate === "agent_message_chunk" &&
            event.payload.content.type === "text"
        ) {
            text += event.payload.content.text;
        } else if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
            expect(event.payload.stopReason).toBe("end_turn");
            expect(text).toContain("FORK_PERMISSION_DONE");
            return approvals;
        }
    }
}
