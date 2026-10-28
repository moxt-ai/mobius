import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    type PromptAttachment,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { withControlledDaemon } from "../support/agents/real-daemon.ts";
import { uploadPromptContent } from "../support/agents/upload-prompt-content.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

test("Given unsupported attachments, When a prompt has text, Then the daemon delivers text and records warnings without losing the connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "old-pdf-peer-"));
    try {
        const executable = await writeControlledAcpExecutable(directory);
        await withControlledDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent"),
                PATH: executable,
            },
            async (peer) => {
                const finish = async (id: string) => {
                    let visibleWarning = false;
                    let output = "";
                    for (;;) {
                        const raw = await peer.nextMessage();
                        if (JSON.parse(raw).kind !== "session.event.v2") {
                            continue;
                        }
                        for (const event of decodeSessionEventEnvelope(raw).events) {
                            if (JSON.stringify(event).includes("Mobius skipped attachments:")) {
                                visibleWarning = true;
                            }
                            if (event.type === "acp") {
                                if (
                                    event.payload.sessionUpdate === "agent_message_chunk" &&
                                    event.payload.content.type === "text"
                                ) {
                                    output += event.payload.content.text;
                                }
                                continue;
                            }
                            const payload = event.payload;
                            if (!("commandId" in payload) || payload.commandId !== id) {
                                continue;
                            }
                            if (
                                ["prompt.completed", "prompt.failed", "prompt.failed-before-start"].includes(
                                    payload.kind,
                                )
                            ) {
                                return { payload, visibleWarning, output };
                            }
                        }
                    }
                };
                const send = async (attachments: readonly PromptAttachment[], prompt: string) => {
                    const commandId = randomUUID();
                    peer.send(
                        encodeSessionPromptCommand({
                            additionalDirectoryIds: [],
                            agentId: "controlled-acp",
                            attachments,
                            bindingId: peer.bindingId,
                            commandId,
                            directoryId: "default",
                            disposition: SessionPromptDisposition.Reject,
                            kind: "session.prompt",
                            prompt,
                            sessionId: peer.sessionId,
                            targetCommandId: "",
                        }),
                    );
                    return finish(commandId);
                };
                peer.send(
                    JSON.stringify({ kind: "session.future.read", requestId: randomUUID(), sessionId: peer.sessionId }),
                );
                for (const input of [
                    {
                        bytes: new TextEncoder().encode("%PDF-1.4\nHello PDF"),
                        mediaType: "application/pdf",
                        name: "document.pdf",
                    },
                    {
                        bytes: new TextEncoder().encode(`<svg>${" ".repeat(1_000_001)}</svg>`),
                        mediaType: "image/svg+xml",
                        name: "large.svg",
                    },
                ]) {
                    const attachment = await uploadPromptContent(peer, {
                        ...input,
                        kind: "resource",
                        uri: `attachment:///${input.name}`,
                    });
                    const outcome = await send([attachment], "Read attached file");
                    expect(outcome.payload.kind).toBe("prompt.completed");
                    expect(outcome.visibleWarning).toBe(true);
                    expect(outcome.output).toContain("Read attached file");
                    expect(outcome.output).toContain("Mobius skipped attachments:");
                    const onlyAttachment = await send([attachment], "");
                    expect(onlyAttachment.payload).toMatchObject({
                        kind: "prompt.failed-before-start",
                        code: "prompt_attachments_unsupported",
                    });
                    const recovery = await send([], "Still connected after attachment rejection");
                    expect(recovery.payload.kind).toBe("prompt.completed");
                }
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
