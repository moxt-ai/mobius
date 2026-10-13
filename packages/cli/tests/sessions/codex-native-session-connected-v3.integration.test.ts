import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionLiveEventV3 } from "@moxt-ai/mobius-protocol";
import { afterEach, expect, test } from "vitest";
import { openSessionLiveStateV3Database } from "../../src/local-databases.ts";
import { codexNativeSessionAdapterDefinitionV3 } from "../../src/native-sessions/adapters/codex/definition-v3.ts";
import { NativeSessionRuntimeManagerV3 } from "../../src/native-sessions/runtime-manager-v3.ts";
import { SessionLiveStateV3 } from "../../src/native-sessions/session-live-state-v3.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

test("Given a connected Codex Session, When a prompt streams and history is reconciled across reconnect, Then sequence increases and native identity is stable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-codex-connected-v3-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "codex");
    await writeFile(
        executable,
        `#!${process.execPath}
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.method === "initialized") continue;
    if (request.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
        continue;
    }
    if (request.method === "thread/resume") {
        process.stdout.write(JSON.stringify({
            id: request.id,
            result: { thread: { id: request.params.threadId, turns: [] } }
        }) + "\\n");
        continue;
    }
    if (request.method === "thread/start") {
        process.stdout.write(JSON.stringify({
            id: request.id,
            result: { thread: { id: "native-thread-1" } }
        }) + "\\n");
        continue;
    }
    if (request.method === "thread/turns/list") {
        process.stdout.write(JSON.stringify({
            method: "item/agentMessage/delta",
            params: { delta: "streamed", itemId: "codex-item-1", threadId: request.params.threadId, turnId: "turn-1" }
        }) + "\\n");
        process.stdout.write(JSON.stringify({
            id: request.id,
            result: {
                data: [{ items: [{ id: "codex-item-1", text: "complete", type: "agentMessage" }] }],
                nextCursor: null
            }
        }) + "\\n");
        continue;
    }
    if (request.method === "turn/start") {
        process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress" } } }) + "\\n");
        process.stdout.write(JSON.stringify({
            method: "turn/started",
            params: { threadId: request.params.threadId, turn: { id: "turn-1", status: "inProgress" } }
        }) + "\\n");
        process.stdout.write(JSON.stringify({
            method: "item/agentMessage/delta",
            params: { delta: "answer", itemId: "codex-item-1", threadId: request.params.threadId, turnId: "turn-1" }
        }) + "\\n");
        process.stdout.write(JSON.stringify({
            method: "turn/completed",
            params: { threadId: request.params.threadId, turn: { id: "turn-1", status: "completed" } }
        }) + "\\n");
        continue;
    }
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: "Unexpected method" } }) + "\\n");
}
`,
        { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const database = openSessionLiveStateV3Database(join(directory, "live.sqlite"));
    const state = new SessionLiveStateV3(database);
    const events: SessionLiveEventV3[] = [];
    let throughSeq = 0;
    const live = {
        publish: async (item: SessionLiveEventV3["item"]): Promise<void> => {
            const event = state.commit("session-1", item);
            throughSeq = event.seq;
            events.push(event);
        },
        readThroughSeq: () => throughSeq,
    };
    const runtime = new NativeSessionRuntimeManagerV3([codexNativeSessionAdapterDefinitionV3]);
    const agent = { command: executable, environment: {}, id: "codex" };
    const session = {
        additionalDirectories: [],
        cwd: directory,
        nativeSessionId: "native-thread-1",
        sessionId: "session-1",
    };
    const signal = AbortSignal.timeout(30_000);
    try {
        const first = await runtime.create(
            agent,
            {
                additionalDirectories: session.additionalDirectories,
                cwd: session.cwd,
                sessionId: session.sessionId,
            },
            live,
            signal,
        );
        expect(first.nativeSessionId).toBe("native-thread-1");
        expect(await first.runPrompt({ images: [], prompt: "hello", resources: [] }, signal)).toEqual({
            stopReason: "end_turn",
        });
        const firstPage = await first.pageMessages({ cursor: null, messageLimit: 10, sessionId: "session-1" }, signal);
        expect(events.map((event) => event.seq)).toEqual([1, 2]);
        expect(firstPage).toMatchObject({
            messages: [{ messageId: "codex-item-1", item: { sessionUpdate: "agent_message" } }],
            throughSeq: 2,
        });
        await runtime.closeSession("session-1", signal);

        const second = await runtime.prepare(agent, session, live, signal);
        const secondPage = await second.pageMessages(
            { cursor: null, messageLimit: 10, sessionId: "session-1" },
            signal,
        );
        expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
        expect(secondPage.messages.map((message) => message.messageId)).toEqual(["codex-item-1"]);
        expect(secondPage.throughSeq).toBe(4);
    } finally {
        await runtime.close(AbortSignal.timeout(30_000));
        database.close();
    }
});
