import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { piNativeSessionAdapterDefinitionV3 } from "../../src/native-sessions/adapters/pi/definition-v3.ts";
import { NativeSessionRuntimeManagerV3 } from "../../src/native-sessions/runtime-manager-v3.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

test("Given a Pi active branch with persisted entry IDs, When V3 preview pages it, Then item-ID cursors preserve those identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-pi-preview-v3-"));
    temporaryDirectories.push(directory);
    const workspace = join(directory, "workspace");
    const sessionDirectory = join(directory, "sessions");
    const nativeSessionId = "11111111-1111-4111-8111-111111111111";
    const manager = SessionManager.create(workspace, sessionDirectory, { id: nativeSessionId });
    const firstEntryId = manager.appendMessage({ content: "First", role: "user", timestamp: 1 });
    const secondEntryId = manager.appendMessage({ content: "Second", role: "user", timestamp: 2 });
    const runtime = new NativeSessionRuntimeManagerV3([piNativeSessionAdapterDefinitionV3]);
    const agent = {
        command: "pi",
        environment: { PI_CODING_AGENT_SESSION_DIR: sessionDirectory },
        id: "pi",
    };
    const session = { additionalDirectories: [], cwd: workspace, nativeSessionId, sessionId: "session-1" };
    const signal = AbortSignal.timeout(30_000);

    const first = await runtime.previewMessages(
        agent,
        session,
        { cursor: null, messageLimit: 1, sessionId: "session-1" },
        signal,
    );
    expect(first.messages.map((message) => message.messageId)).toEqual([firstEntryId]);
    expect(first.nextCursor).toBe(firstEntryId);

    const second = await runtime.previewMessages(
        agent,
        session,
        { cursor: first.nextCursor, messageLimit: 1, sessionId: "session-1" },
        signal,
    );
    expect(second.messages.map((message) => message.messageId)).toEqual([secondEntryId]);
    expect(second.nextCursor).toBeNull();
    expect(second.throughSeq).toBe(0);
});
