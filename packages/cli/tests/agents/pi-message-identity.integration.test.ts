import { addAbortListener } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContentBlock, PROTOCOL_VERSION, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpSessionUpdate } from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { z } from "zod";
import { piClientCallbacks } from "../../src/engine/acp/adapter/pi/client-callbacks.ts";
import { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import { imageFixture } from "../support/agents/image-fixture.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

function identityCallbacks(onUpdate: (update: AcpSessionUpdate) => void) {
    const rejectInteraction = async (): Promise<never> => {
        throw new Error("Unexpected interaction or embedded media");
    };
    return piClientCallbacks(
        {
            onSessionEvent: async (_nativeSessionId, event) => onUpdate(event.payload),
            interactions: { onPermission: rejectInteraction, onElicitation: rejectInteraction },
        },
        new AcpContentExternalizer(rejectInteraction),
    );
}

test("Given real Pi is waiting for model output, When two multi-block steers are accepted, Then user chunks arrive only when Pi consumes them with distinct message identities", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const signal = AbortSignal.timeout(60_000);
    using _abort = addAbortListener(signal, () => release.resolve());
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_STEERING_IDENTITY_REPLY", {
        beforeFirstText: async () => {
            entered.resolve();
            await release.promise;
        },
    });
    await using fixture = await PiFixture.create(provider);
    const cwd = await mkdtemp(join(tmpdir(), "mobius-pi-steering-identity-"));
    const updates: AcpSessionUpdate[] = [];
    const client = fixture.createClient(identityCallbacks((update) => updates.push(update)));
    try {
        await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId } = await client.newSession({ cwd, mcpServers: [] }, signal);
        const pending = client.prompt(
            { sessionId, prompt: [{ type: "text", text: "Wait for updated instructions" }] },
            signal,
        );
        // Always settle the in-flight prompt, including on assertion failure.
        const finished = pending.then(
            (result) => ({ kind: "completed" as const, result }),
            (cause: unknown) => ({ kind: "failed" as const, cause }),
        );
        try {
            await Promise.race([
                entered.promise,
                finished.then(() => {
                    throw new Error("Prompt ended before model gate");
                }),
            ]);
            updates.length = 0;
            for (const text of ["First steering", "Second steering"]) {
                const response = await client.steer(
                    {
                        sessionId,
                        prompt: [
                            { type: "text", text },
                            { type: "text", text: `${text} detail` },
                        ],
                    },
                    signal,
                );
                expect(response).toMatchObject({ outcome: "injected" });
            }
            expect(updates.filter((update) => update.sessionUpdate === "user_message_chunk")).toEqual([]);
        } finally {
            release.resolve();
            await finished;
        }
        const outcome = await finished;
        if (outcome.kind === "failed") {
            throw outcome.cause;
        }
        const chunks = updates.filter((update) => update.sessionUpdate === "user_message_chunk");
        expect(chunks.map((update) => update.content)).toEqual([
            { type: "text", text: "First steeringFirst steering detail" },
            { type: "text", text: "Second steeringSecond steering detail" },
        ]);
        expect(chunks[0]?.messageId).toEqual(expect.any(String));
        expect(chunks[1]?.messageId).toEqual(expect.any(String));
        expect(chunks[0]?.messageId).not.toBe(chunks[1]?.messageId);
    } finally {
        release.resolve();
        await client.dispose();
        await rm(cwd, { recursive: true, force: true });
    }
});

test("Given real Pi transforms input, When a user submits a prompt, Then raw user chunks contain Pi's consumed content without adapter-generated identity", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_RAW_REPLY");
    await using fixture = await PiFixture.create(provider);
    await fixture.installExtension(
        "transform-input.js",
        `export default function (pi) {
            pi.on("input", async (event) => event.text === "Reply without tools"
                ? { action: "transform", text: "PI_NATIVE_TRANSFORMED_INPUT" }
                : { action: "continue" });
        }`,
    );
    const cwd = await mkdtemp(join(tmpdir(), "mobius-pi-raw-identity-"));
    const updates: SessionUpdate[] = [];
    const image: ContentBlock = { type: "image", data: imageFixture(128).toString("base64"), mimeType: "image/png" };
    const client = fixture.createClient({
        sessionUpdate: async ({ update }) => {
            updates.push(update);
            if (
                update.sessionUpdate === "user_message_chunk" &&
                update.content.type === "text" &&
                update.content.text.startsWith("Cancel during echo")
            ) {
                await client.cancel({ sessionId: cancelledSessionId });
                await client.listSessions({});
            }
        },
        startUserMessage: () => undefined,
        requestPermission: async () => {
            throw new Error("Unexpected permission request");
        },
        requestElicitation: async () => {
            throw new Error("Unexpected input request");
        },
    });
    const signal = AbortSignal.timeout(60_000);
    let cancelledSessionId = "";
    try {
        await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const session = await client.newSession({ cwd, mcpServers: [] }, signal);
        const response = await client.prompt(
            { sessionId: session.sessionId, prompt: [{ type: "text", text: "Reply without tools" }, image] },
            signal,
        );
        const chunks = updates.filter(
            (update) => update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk",
        );
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.filter((update) => update.sessionUpdate === "user_message_chunk")).toEqual([
            { sessionUpdate: "user_message_chunk", content: { type: "text", text: "PI_NATIVE_TRANSFORMED_INPUT" } },
            { sessionUpdate: "user_message_chunk", content: image },
        ]);
        for (const chunk of chunks) {
            expect(chunk).not.toHaveProperty("messageId");
        }
        expect(response._meta ?? {}).not.toHaveProperty("messageId");
        cancelledSessionId = session.sessionId;
        expect(
            await client.prompt(
                {
                    sessionId: session.sessionId,
                    prompt: [
                        { type: "text", text: "Cancel during echo" },
                        { type: "text", text: "Do not submit this turn" },
                    ],
                },
                signal,
            ),
        ).toMatchObject({ stopReason: "cancelled" });
        expect(
            await client.prompt(
                { sessionId: session.sessionId, prompt: [{ type: "text", text: "Continue after cancellation" }] },
                signal,
            ),
        ).toMatchObject({ stopReason: "end_turn" });
    } finally {
        await client.dispose();
        await rm(cwd, { recursive: true, force: true });
    }
});

test("Given real Pi streams multiple messages, When the harness emits chunks, replays history and exports a session, Then each message has one messageId and no nativeMessageId", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_IDENTITY_REPLY");
    await using fixture = await PiFixture.create(provider);
    await fixture.overrideSettings({ quietStartup: false });
    const cwd = await mkdtemp(join(tmpdir(), "mobius-pi-message-identity-"));
    const updates: AcpSessionUpdate[] = [];
    const observed: AcpSessionUpdate[] = [];
    const client = fixture.createClient(
        identityCallbacks((update) => {
            updates.push(update);
            observed.push(update);
        }),
    );
    const signal = AbortSignal.timeout(60_000);
    try {
        await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
        const { sessionId, _meta } = await client.newSession({ cwd, mcpServers: [] }, signal);
        const startupInfo = z.object({ piAcp: z.object({ startupInfo: z.string().nullable() }) }).parse(_meta)
            .piAcp.startupInfo;
        const ids = new Set<string>();
        for (const prompt of [
            "Stream a short greeting, without tools",
            "Stream another short greeting, without tools",
        ]) {
            updates.length = 0;
            const result = await client.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] }, signal);
            const messages = updates.filter((update) => update.sessionUpdate === "agent_message_chunk");
            const userMessages = updates.filter((update) => update.sessionUpdate === "user_message_chunk");
            expect(userMessages).toHaveLength(1);
            expect(userMessages[0]?.messageId).toEqual(expect.any(String));
            expect(result._meta ?? {}).not.toHaveProperty("messageId");
            expect(messages.length).toBeGreaterThan(1);
            expect(
                messages.flatMap((update) => (update.content.type === "text" ? [update.content.text] : [])).join(""),
            ).toContain(provider.response);
            // A scheduled harness-authored startup notice can arrive during the first prompt.
            // Its declared text is a separate message, not part of the model response.
            const modelMessages = messages.filter(
                (update) => update.content.type !== "text" || update.content.text !== startupInfo,
            );
            expect(modelMessages.length).toBeGreaterThan(1);
            const messageIds = new Set(modelMessages.map((update) => update.messageId));
            expect(messageIds.size).toBe(1);
            for (const update of messages) {
                const id = update.messageId;
                if (typeof id !== "string" || id.length === 0) {
                    throw new Error("Pi did not identify its message");
                }
                expect(ids.has(id)).toBe(false);
                expect(Object.hasOwn(update, "nativeMessageId")).toBe(false);
            }
            for (const id of messageIds) {
                if (typeof id === "string") {
                    ids.add(id);
                }
            }
        }
        const startupMessages = observed
            .filter((update) => update.sessionUpdate === "agent_message_chunk")
            .filter((update) => update.content.type === "text" && update.content.text === startupInfo);
        expect(startupMessages).toHaveLength(1);
        for (const update of startupMessages) {
            if (typeof update.messageId !== "string" || update.messageId.length === 0) {
                throw new Error("Pi did not identify its startup message");
            }
            expect(ids.has(update.messageId)).toBe(false);
            expect(Object.hasOwn(update, "nativeMessageId")).toBe(false);
        }
        updates.length = 0;
        await client.prompt({ sessionId, prompt: [{ type: "text", text: "/export" }] }, signal);
        const exported = updates.filter((update) => update.sessionUpdate === "agent_message_chunk");
        expect(exported.map((update) => update.content.type)).toEqual(["text", "resource_link"]);
        expect(new Set(exported.map((update) => update.messageId)).size).toBe(1);
        updates.length = 0;
        await client.loadSession({ sessionId, cwd, mcpServers: [] }, signal);
        const replay = updates.filter(
            (update) =>
                update.sessionUpdate === "agent_message_chunk" ||
                update.sessionUpdate === "user_message_chunk" ||
                update.sessionUpdate === "agent_thought_chunk",
        );
        expect(replay.length).toBeGreaterThan(0);
        for (const update of replay) {
            expect(update.messageId).toEqual(expect.any(String));
            expect(Object.hasOwn(update, "nativeMessageId")).toBe(false);
        }
        for (const [index, update] of observed.entries()) {
            if (
                update.sessionUpdate !== "user_message_chunk" &&
                update.sessionUpdate !== "agent_message_chunk" &&
                update.sessionUpdate !== "agent_thought_chunk"
            ) {
                continue;
            }
            const previous = observed[index - 1];
            if (previous?.sessionUpdate === update.sessionUpdate) {
                expect(update.messageId).toBe(previous.messageId);
            } else if (previous !== undefined && "messageId" in previous) {
                expect(update.messageId).not.toBe(previous.messageId);
            }
        }
    } finally {
        await client.dispose();
        await rm(cwd, { recursive: true, force: true });
    }
});
