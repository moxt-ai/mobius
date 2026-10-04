import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeRecordedSessionEvent,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../../packages/cli/src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../infra/codex.ts";
import { writeCodexFaultLauncher } from "../infra/codex-process-fault.ts";
import { withRealDaemon } from "../infra/real-daemon.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

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
                        const event = decodeRecordedSessionEvent(await peer.nextEvent());
                        if ("commandId" in event && event.commandId !== commandId) {
                            continue;
                        }
                        if (event.kind === "agent.message.delta") {
                            text += event.text;
                        }
                        if (event.kind === "session.failed" || event.kind === "session.completed") {
                            return { event, text };
                        }
                    }
                };
                expect(await run()).toMatchObject({
                    event: { kind: "session.completed" },
                    text: expect.stringContaining("RECOVERED_REPLY"),
                });
                for (const fault of ["before-ack", "after-ack", "invalid-frame"]) {
                    await writeFile(faultPath, fault);
                    const failed = await run();
                    expect(failed.event).toMatchObject({
                        kind: "session.failed",
                        code: fault === "invalid-frame" ? "codex_app_server_protocol_error" : "codex_app_server_exited",
                    });
                    expect(await run()).toMatchObject({
                        event: { kind: "session.completed" },
                        text: expect.stringContaining("RECOVERED_REPLY"),
                    });
                }
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
