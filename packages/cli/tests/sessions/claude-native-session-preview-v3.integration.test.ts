import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";
import { claudeNativeSessionAdapterDefinitionV3 } from "../../src/native-sessions/adapters/claude/definition-v3.ts";
import { NativeSessionRuntimeManagerV3 } from "../../src/native-sessions/runtime-manager-v3.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

test("Given a Claude transcript with stable UUIDs, When V3 preview loads bounded pages, Then its cursor resumes by UUID and offset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-claude-preview-v3-"));
    temporaryDirectories.push(directory);
    const workspace = join(directory, "workspace");
    const configDirectory = join(directory, "claude");
    const projectKey = workspace.replaceAll(/[^a-zA-Z0-9]/gu, "-");
    const projectDirectory = join(configDirectory, "projects", projectKey);
    await mkdir(projectDirectory, { recursive: true });
    const nativeSessionId = "11111111-1111-4111-8111-111111111111";
    const userUuid = "22222222-2222-4222-8222-222222222222";
    const assistantUuid = "33333333-3333-4333-8333-333333333333";
    await writeFile(
        join(projectDirectory, `${nativeSessionId}.jsonl`),
        [
            {
                message: { content: "Question", role: "user" },
                parentUuid: null,
                sessionId: nativeSessionId,
                timestamp: "2026-10-13T00:00:00.000Z",
                type: "user",
                uuid: userUuid,
            },
            {
                message: { content: [{ text: "Answer", type: "text" }], role: "assistant" },
                parentUuid: userUuid,
                sessionId: nativeSessionId,
                timestamp: "2026-10-13T00:00:01.000Z",
                type: "assistant",
                uuid: assistantUuid,
            },
        ]
            .map((entry) => JSON.stringify(entry))
            .join("\n"),
    );
    const runtime = new NativeSessionRuntimeManagerV3([claudeNativeSessionAdapterDefinitionV3]);
    const agent = {
        command: "claude",
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        id: "claude",
    };
    const session = {
        additionalDirectories: [],
        cwd: workspace,
        nativeSessionId,
        sessionId: "session-1",
    };
    const signal = AbortSignal.timeout(30_000);

    const first = await runtime.previewMessages(
        agent,
        session,
        { cursor: null, messageLimit: 1, sessionId: "session-1" },
        signal,
    );
    expect(first.messages.map((message) => message.messageId)).toEqual([userUuid]);
    expect(first.nextCursor).toMatch(/^mobius-claude-v3:/u);

    const second = await runtime.previewMessages(
        agent,
        session,
        { cursor: first.nextCursor, messageLimit: 1, sessionId: "session-1" },
        signal,
    );
    expect(second).toEqual({
        messages: [
            {
                item: { content: [{ text: "Answer", type: "text" }], sessionUpdate: "agent_message" },
                messageId: assistantUuid,
                sessionId: "session-1",
            },
        ],
        nextCursor: null,
        throughSeq: 0,
    });
});
