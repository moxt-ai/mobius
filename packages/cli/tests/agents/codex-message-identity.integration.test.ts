import { addAbortListener } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { z } from "zod";
import { createAcpClient } from "../../src/engine/acp/connection/create-client.ts";
import { CodexAcpAgent } from "../../src/engine/acp/harness/codex/agent.ts";
import { CodexAppServerClient } from "../../src/engine/acp/harness/codex/app-server-client.ts";
import {
    threadResumeResponseSchema,
    threadStartResponseSchema,
} from "../../src/engine/acp/harness/codex/app-server-protocol.ts";
import { decodeThreadItem } from "../../src/engine/acp/harness/codex/items.ts";
import type { CodexSessionUpdate } from "../../src/engine/acp/harness/codex/session-update.ts";
import { stopProcessTree } from "../../src/engine/util/process/executable.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test.each(["owned", "borrowed"])(
    "Given a real %s Codex session, When the harness streams a message and replays history, Then every message has its native messageId",
    async (ownership) => {
        await using provider = await FakeOpenAiProvider.start("mobius-test-model", "Native identity reply");
        await using codex = await CodexFixture.create(provider, { configuredModel: "mobius-test-model" });
        const cwd = await mkdtemp(join(tmpdir(), "mobius-codex-message-identity-"));
        const updates: CodexSessionUpdate[] = [];
        const seeded = Promise.withResolvers<void>();
        const endpoint = new CodexAcpAgent({
            command: codex.executable,
            cwd,
            environment: codex.environment,
            onSessionUpdate: async ({ update }) => {
                updates.push(update);
            },
        });
        const connection = createAcpClient({
            onUpdate: async () => undefined,
            onPermission: async () => {
                throw new Error("The message identity scenario must not request permission");
            },
            onElicitation: async () => {
                throw new Error("The message identity scenario must not request input");
            },
            onElicitationComplete: async () => undefined,
        }).connect(endpoint.app());
        const signal = AbortSignal.timeout(60_000);
        try {
            await endpoint.initialize(signal);
            await connection.agent.request(
                methods.agent.initialize,
                {
                    protocolVersion: PROTOCOL_VERSION,
                    clientCapabilities: {},
                },
                { cancellationSignal: signal },
            );
            const native = new CodexAppServerClient({
                command: codex.executable,
                cwd,
                environment: codex.environment,
                handlers: {
                    onNotification: async (method) => {
                        if (method === "turn/completed") {
                            seeded.resolve();
                        }
                    },
                    onServerRequest: async () => {
                        throw new Error("The identity scenario must not request native input");
                    },
                },
            });
            try {
                await native.initialize(signal);
                let sessionId: string;
                if (ownership === "owned") {
                    const created = await connection.agent.request(
                        methods.agent.session.new,
                        {
                            cwd,
                            mcpServers: [],
                        },
                        { cancellationSignal: signal },
                    );
                    sessionId = created.sessionId;
                } else {
                    const created = threadStartResponseSchema.parse(
                        await native.request("thread/start", { cwd, model: "mobius-test-model" }, signal),
                    );
                    sessionId = created.thread.id;
                    await native.request(
                        "turn/start",
                        {
                            threadId: sessionId,
                            input: [{ type: "text", text: "Seed the native conversation", text_elements: [] }],
                        },
                        signal,
                    );
                    {
                        using _listener = addAbortListener(signal, () => seeded.reject(signal.reason));
                        await seeded.promise;
                    }
                    const loaded = await connection.agent.request(
                        methods.agent.session.load,
                        { sessionId, cwd, mcpServers: [] },
                        { cancellationSignal: signal },
                    );
                    expect(loaded._meta).toMatchObject({ steering: { supported: false } });
                    updates.length = 0;
                }
                const resource = {
                    type: "resource",
                    resource: {
                        uri: "morty://bot/instructions",
                        mimeType: "text/plain",
                        text: "Keep the reply concise",
                    },
                } satisfies import("@agentclientprotocol/sdk").ContentBlock;
                const result = await connection.agent.request(
                    methods.agent.session.prompt,
                    {
                        sessionId,
                        prompt: [{ type: "text", text: "Reply with a short greeting, without tools" }, resource],
                    },
                    { cancellationSignal: signal },
                );
                const live = updates.filter((update) => update.sessionUpdate === "agent_message_chunk");
                const userMessages = updates.filter((update) => update.sessionUpdate === "user_message_chunk");
                expect(userMessages).toHaveLength(2);
                expect(userMessages[1]).toMatchObject({ content: resource, messageId: userMessages[0]?.messageId });
                expect(userMessages[0]?.messageId).toEqual(expect.any(String));
                expect(z.object({ _meta: z.object({ messageId: z.string() }) }).parse(result)._meta.messageId).toBe(
                    userMessages[0]?.messageId,
                );
                expect(live.length).toBeGreaterThan(0);
                for (const update of live) {
                    expect(update.messageId).toEqual(expect.any(String));
                }
                const saved = threadResumeResponseSchema.parse(
                    await native.request("thread/read", { threadId: sessionId, includeTurns: true }, signal),
                );
                const nativeIds = saved.thread.turns.flatMap((turn) =>
                    turn.items.flatMap((raw) => {
                        const item = decodeThreadItem(raw);
                        return item?.type === "agentMessage" ? [item.id] : [];
                    }),
                );
                for (const update of live) {
                    expect(nativeIds).toContain(update.messageId);
                }
                updates.length = 0;
                await connection.agent.request(
                    methods.agent.session.load,
                    {
                        sessionId,
                        cwd,
                        mcpServers: [],
                    },
                    { cancellationSignal: signal },
                );
                const history = updates.filter((update) => update.sessionUpdate === "agent_message_chunk");
                expect(history.length).toBeGreaterThan(0);
                const historyIds = history.map((update) => update.messageId);
                expect(new Set(history.map((update) => update.messageId))).toEqual(new Set(nativeIds));
                for (const update of live) {
                    expect(historyIds).toContain(update.messageId);
                }
            } finally {
                native.detach();
                await stopProcessTree(native.child());
            }
        } finally {
            await endpoint.close();
            connection.close();
            await rm(cwd, { recursive: true, force: true });
        }
    },
);
