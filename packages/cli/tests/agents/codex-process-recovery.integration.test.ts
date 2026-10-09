import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSessionEventV2, encodeSessionPromptCommand, SessionPromptDisposition } from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { writeCodexFaultLauncher } from "../support/agents/codex-process-fault.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given an existing real Codex conversation, When the process exits or its transport is corrupted, Then the daemon reports a typed failure and can continue that conversation", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "RECOVERED_REPLY");
    await using codex = await CodexFixture.create(provider);
    const directory = await mkdtemp(join(tmpdir(), "mobius-codex-fault-"));
    const launcher = join(directory, "codex.mjs");
    const faultPath = join(directory, "fault");
    try {
        await writeCodexFaultLauncher(codex, launcher, faultPath);
        await withRealDaemon(
            new CodexAgentSpecification(),
            { ...codex.environment, MOBIUS_CODEX_PATH: launcher },
            async (peer) => {
                const run = async () => {
                    const commandId = randomUUID();
                    peer.send(
                        encodeSessionPromptCommand({
                            kind: "session.prompt",
                            commandId,
                            sessionId: peer.sessionId,
                            agentId: "codex",
                            bindingId: peer.bindingId,
                            directoryId: "default",
                            additionalDirectoryIds: [],
                            images: [],
                            resources: [],
                            prompt: "Continue the conversation",
                            disposition: SessionPromptDisposition.Reject,
                            targetCommandId: "",
                        }),
                    );
                    let text = "";
                    for (;;) {
                        const event = decodeSessionEventV2(JSON.parse(await peer.nextEvent()));
                        if (
                            event.type === "lifecycle-metadata" &&
                            "commandId" in event.payload &&
                            event.payload.commandId !== commandId
                        ) {
                            continue;
                        }
                        if (
                            event.type === "acp" &&
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            text += event.payload.content.text;
                        }
                        if (
                            (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") ||
                            (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed")
                        ) {
                            return { event, text };
                        }
                    }
                };
                expect(await run()).toMatchObject({
                    event: { payload: { kind: "prompt.completed" } },
                    text: expect.stringContaining("RECOVERED_REPLY"),
                });
                for (const fault of ["before-ack", "after-ack", "invalid-frame"]) {
                    await writeFile(faultPath, fault);
                    const failed = await run();
                    expect(failed.event).toMatchObject({
                        payload: {
                            kind: "prompt.failed",
                            code:
                                fault === "invalid-frame"
                                    ? "codex_app_server_protocol_error"
                                    : "codex_app_server_exited",
                        },
                    });
                    expect(await run()).toMatchObject({
                        event: { payload: { kind: "prompt.completed" } },
                        text: expect.stringContaining("RECOVERED_REPLY"),
                    });
                }
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
