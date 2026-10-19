import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEvent,
    encodeNativeSessionCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAppServerClient } from "../../src/acp/harness/codex/app-server-client.ts";
import { CodexAgentSpecification } from "../../src/agent-catalog/agents/codex-agent.ts";
import { stopProcessTree } from "../../src/util/process/executable.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given another local Codex owns the Session lock, When Morty opens and prompts that Session, Then the daemon queues the message and returns its owner's reply without forking", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "LOCKED_SESSION_REPLY", {
        beforeFirstText: async () => {
            if (hold) {
                entered.resolve();
                await release.promise;
            }
        },
    });
    await using fixture = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), fixture.environment, async (peer) => {
        let completed = Promise.withResolvers<void>();
        const owner = new CodexAppServerClient({
            command: fixture.executable,
            cwd: peer.workspace,
            environment: fixture.environment,
            handlers: {
                onNotification: async (method) => {
                    if (method === "turn/completed") {
                        completed.resolve();
                    }
                },
                onServerRequest: async () => {},
            },
        });
        try {
            await owner.initialize(peer.signal);
            const started = await owner.request(
                "thread/start",
                { cwd: peer.workspace, model: "mobius-test-model" },
                peer.signal,
            );
            const thread: unknown =
                typeof started === "object" && started !== null ? Reflect.get(started, "thread") : undefined;
            const id: unknown = typeof thread === "object" && thread !== null ? Reflect.get(thread, "id") : undefined;
            if (typeof id !== "string") {
                throw new Error("Missing Codex identity");
            }
            const start = async (text: string): Promise<void> => {
                await owner.request(
                    "turn/start",
                    { threadId: id, input: [{ type: "text", text, text_elements: [] }] },
                    peer.signal,
                );
            };
            await start("Local seed");
            await completed.promise;
            const base = {
                kind: "native.session.request",
                agentId: "codex",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
                sessionId: id,
            } as const;
            peer.send(encodeNativeSessionCommand({ ...base, action: "list", requestId: "list", cursor: null }));
            let entryId = "";
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "native.session.result") {
                    const result = decodeNativeSessionResult(message);
                    if (result.action === "list") {
                        entryId = result.entries[0]?.entryId ?? "";
                        break;
                    }
                }
            }
            expect(entryId).not.toBe("");
            peer.send(
                encodeNativeSessionCommand({
                    ...base,
                    action: "import",
                    requestId: "open",
                    entryId,
                    targetSessionId: id,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) === "native.session.result") {
                    const result = decodeNativeSessionResult(message);
                    if (result.requestId === "open") {
                        expect(result).toMatchObject({ action: "import", ready: { sessionId: id } });
                        break;
                    }
                }
                if (message.includes('"error"') || message.includes('"failed"')) {
                    throw new Error(message);
                }
            }
            completed = Promise.withResolvers<void>();
            hold = true;
            await start("Local owner is still running");
            await entered.promise;
            const commandId = randomUUID();
            peer.send(
                encodeSessionPromptCommand({
                    ...base,
                    kind: "session.prompt",
                    commandId,
                    prompt: "Queued from Morty",
                    images: [],
                    resources: [],
                    disposition: SessionPromptDisposition.Reject,
                    targetCommandId: "",
                }),
            );
            // The public prompt-started event establishes that the daemon accepted the remote turn.
            let reply = "";
            for (;;) {
                const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.started") {
                    release.resolve();
                }
                if (
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "agent_message_chunk" &&
                    event.payload.content.type === "text"
                ) {
                    reply += event.payload.content.text;
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                    expect(event.payload.commandId).toBe(commandId);
                    break;
                }
            }
            expect(reply).toContain("LOCKED_SESSION_REPLY");
            const history = await owner.request("thread/read", { threadId: id, includeTurns: true }, peer.signal);
            expect(JSON.stringify(history)).toContain("Queued from Morty");
        } finally {
            release.resolve();
            owner.detach();
            await stopProcessTree(owner.child());
        }
    });
});
