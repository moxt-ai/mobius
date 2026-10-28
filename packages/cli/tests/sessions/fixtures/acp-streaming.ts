import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { waitForAbort, waitForFile } from "../../support/acp-process.ts";
import { type ControlledSessionState, type nativeHistory, persistState } from "./acp-session-state.ts";

export async function runStreamingScenario(
    context: acp.AgentRequestContext<acp.PromptRequest>,
    prompt: string,
    turnNumber: number,
    cancellation: AbortController,
    state: ControlledSessionState,
    transcript: NonNullable<ReturnType<typeof nativeHistory.get>>,
): Promise<acp.PromptResponse | undefined> {
    if (prompt.startsWith("stream bounded text ")) {
        const sessionUpdate = prompt.slice("stream bounded text ".length);
        if (
            sessionUpdate !== "user_message_chunk" &&
            sessionUpdate !== "agent_message_chunk" &&
            sessionUpdate !== "agent_thought_chunk" &&
            sessionUpdate !== "compaction_summary_chunk"
        ) {
            throw new Error("Unknown bounded text scenario");
        }
        const samples: readonly (readonly [string, string])[] = [
            ["at-limit", "a".repeat(1_000_000)],
            ["over-limit", "b".repeat(1_000_100)],
            ["unicode-limit", `${"c".repeat(999_961)}\u{1f600}${"d".repeat(137)}`],
        ];
        for (const [messageId, text] of samples) {
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update:
                    sessionUpdate === "compaction_summary_chunk"
                        ? { sessionUpdate, compactionId: messageId, content: { type: "text", text } }
                        : { sessionUpdate, messageId, content: { type: "text", text } },
            });
        }
        return { stopReason: "end_turn" };
    }
    if (prompt === "release before first delta") {
        const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        if (directory === undefined) {
            throw new Error("The controlled Agent state directory is unavailable");
        }
        writeFileSync(join(directory, "prompt-paused"), context.params.sessionId);
        await waitForFile(directory, "resume-turn", cancellation.signal);
        if (cancellation.signal.aborted) {
            return { stopReason: "cancelled" };
        }
    }
    await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
            _meta: { codex: { phase: "commentary" } },
            content: {
                text: "Gathering context",
                type: "text",
            },
            messageId: `progress-${turnNumber.toString()}`,
            sessionUpdate: "agent_message_chunk",
        },
    });
    await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
            content: {
                text: "Inspecting ",
                type: "text",
            },
            messageId: `reasoning-${turnNumber.toString()}`,
            sessionUpdate: "agent_thought_chunk",
        },
    });
    await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
            content: {
                text: "the workspace",
                type: "text",
            },
            messageId: `reasoning-${turnNumber.toString()}`,
            sessionUpdate: "agent_thought_chunk",
        },
    });
    if (prompt === "stream verbose activity") {
        for (let index = 0; index < 64; index += 1) {
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    content: {
                        text: ` step-${index.toString()}`,
                        type: "text",
                    },
                    messageId: `reasoning-${turnNumber.toString()}`,
                    sessionUpdate: "agent_thought_chunk",
                },
            });
        }
    }
    if (prompt === "stream paged reasoning") {
        for (let index = 0; index < 220; index += 1) {
            for (const text of [`chunk-${index.toString()}`, ` detail-${index.toString()}`]) {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        content: { text, type: "text" },
                        messageId: `paged-reasoning-${index.toString()}`,
                        sessionUpdate: "agent_thought_chunk",
                    },
                });
            }
        }
    }
    if (prompt === "stream oversized reasoning") {
        for (let index = 0; index < 8; index += 1) {
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    content: {
                        text:
                            "discarded prefix" +
                            "\u601d\u{1f600}r".repeat(12_000) +
                            ` tail-${index.toString()}${"!".repeat(index % 3)}`,
                        type: "text",
                    },
                    messageId: `reasoning-${turnNumber.toString()}`,
                    sessionUpdate: "agent_thought_chunk",
                },
            });
        }
    }
    if (prompt === "wait until cancelled") {
        await waitForAbort(cancellation.signal);
        return { stopReason: "cancelled" };
    }
    if (
        prompt === "hold after first delta" ||
        prompt === "release after first delta" ||
        prompt === "hold after large output"
    ) {
        if (prompt === "hold after large output") {
            for (let index = 0; index < 30; index += 1) {
                await context.client.notify(acp.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        content: { text: "x".repeat(10_000), type: "text" },
                        messageId: `assistant-${turnNumber.toString()}`,
                        sessionUpdate: "agent_message_chunk",
                    },
                });
            }
            await context.client.notify(acp.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    content: {
                        resource: {
                            blob: "AQ==",
                            mimeType: "application/octet-stream",
                            uri: "file:///long-output.bin",
                        },
                        type: "resource",
                    },
                    messageId: `assistant-${turnNumber.toString()}`,
                    sessionUpdate: "agent_message_chunk",
                },
            });
            await waitForAbort(cancellation.signal);
            return { stopReason: "cancelled" };
        }
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                content: { text: "Partial reply", type: "text" },
                messageId: `assistant-${turnNumber.toString()}`,
                sessionUpdate: "agent_message_chunk",
            },
        });
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                content: {
                    resource: {
                        blob: "AQ==",
                        mimeType: "application/octet-stream",
                        uri: "file:///partial.bin",
                    },
                    type: "resource",
                },
                messageId: `assistant-${turnNumber.toString()}`,
                sessionUpdate: "agent_message_chunk",
            },
        });
        if (prompt === "hold after first delta") {
            await waitForAbort(cancellation.signal);
            return { stopReason: "cancelled" };
        }
        const directory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        if (directory === undefined) {
            throw new Error("The controlled Agent state directory is unavailable");
        }
        await waitForFile(directory, "resume-turn", cancellation.signal);
        if (cancellation.signal.aborted) {
            return { stopReason: "cancelled" };
        }
        await context.client.notify(acp.methods.client.session.update, {
            sessionId: context.params.sessionId,
            update: {
                content: { text: " and more", type: "text" },
                messageId: `assistant-${turnNumber.toString()}`,
                sessionUpdate: "agent_message_chunk",
            },
        });
        transcript.push({
            messageId: `assistant-${turnNumber.toString()}`,
            role: "assistant",
            text: "Partial reply and more",
        });
        persistState(context.params.sessionId, state);
        return { stopReason: "end_turn" };
    }
    return undefined;
}
