import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";
import { codexNativeSessionAdapterDefinitionV3 } from "../../src/native-sessions/adapters/codex/definition-v3.ts";
import { NativeSessionRuntimeManagerV3 } from "../../src/native-sessions/runtime-manager-v3.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

test("Given Codex returns multiple full items in one turn, When V3 preview pages by message, Then it preserves item identity and never opens the thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-codex-preview-v3-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "codex");
    const requestLog = join(directory, "requests.jsonl");
    await writeFile(
        executable,
        `#!${process.execPath}
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const log = process.env.MOBIUS_CODEX_REQUEST_LOG;
for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.method === "initialized") continue;
    await appendFile(log, JSON.stringify({ method: request.method, params: request.params }) + "\\n");
    if (request.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
        continue;
    }
    if (request.method === "thread/turns/list") {
        const older = request.params.cursor === "codex-next";
        process.stdout.write(JSON.stringify({
            id: request.id,
            result: older
                ? { data: [{ items: [{ id: "item-0", text: "Older", type: "agentMessage" }] }], nextCursor: null }
                : { data: [{ items: [
                    { id: "item-1", text: "First", type: "agentMessage" },
                    { id: "item-2", text: "Second", type: "agentMessage" }
                ] }], nextCursor: "codex-next" }
        }) + "\\n");
        continue;
    }
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32601, message: "Unexpected method" } }) + "\\n");
}
`,
        { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const runtime = new NativeSessionRuntimeManagerV3([codexNativeSessionAdapterDefinitionV3]);
    const agent = {
        command: executable,
        environment: { MOBIUS_CODEX_REQUEST_LOG: requestLog },
        id: "codex",
    };
    const session = {
        additionalDirectories: [],
        cwd: directory,
        nativeSessionId: "native-thread-1",
        sessionId: "session-1",
    };
    const signal = AbortSignal.timeout(30_000);

    const first = await runtime.previewMessages(
        agent,
        session,
        { cursor: null, messageLimit: 1, sessionId: "session-1" },
        signal,
    );
    expect(first.messages.map((message) => message.messageId)).toEqual(["item-1"]);
    expect(first.nextCursor).toMatch(/^mobius-codex-v3:/u);

    const second = await runtime.previewMessages(
        agent,
        session,
        { cursor: first.nextCursor, messageLimit: 1, sessionId: "session-1" },
        signal,
    );
    expect(second.messages.map((message) => message.messageId)).toEqual(["item-2"]);
    expect(second.nextCursor).toBe("codex-next");

    const third = await runtime.previewMessages(
        agent,
        session,
        { cursor: second.nextCursor, messageLimit: 1, sessionId: "session-1" },
        signal,
    );
    expect(third.messages.map((message) => message.messageId)).toEqual(["item-0"]);
    expect(third.nextCursor).toBeNull();
    expect(third.throughSeq).toBe(0);

    const requests = (await readFile(requestLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { readonly method: string; readonly params: unknown });
    expect(requests.filter((request) => request.method === "thread/turns/list")).toHaveLength(3);
    expect(requests.some((request) => request.method === "thread/resume")).toBe(false);
});
