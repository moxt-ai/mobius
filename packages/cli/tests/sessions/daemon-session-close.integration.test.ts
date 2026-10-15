import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    decodeMessageKind,
    decodeSessionClosedEvent,
    decodeSessionRestoredEvent,
    encodeSessionCloseCommand,
    encodeSessionRestoreCommand,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { DeepSeekHarnessAgentSpecification } from "../../src/agent-catalog/discover-local-agents.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

test("Given an Agent session holding an exclusive writer lock, When a public close command reaches the daemon, Then restoring the session acquires the released writer lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-session-close-"));
    const executableDirectory = join(directory, "bin");
    const executable = join(executableDirectory, "dsh");
    const nativeStateDirectory = join(directory, "native");
    await Promise.all([mkdir(executableDirectory), mkdir(nativeStateDirectory)]);
    await writeFile(
        executable,
        `#!${process.execPath}\nif (process.argv.includes("--version")) {\n  process.stdout.write("0.1.5-rc.3\\n");\n} else {\n  process.argv.push(\n    "--agent-name", "DeepSeek Harness",\n    "--agent-version", "0.1.5-rc.3",\n    "--exclusive-writer",\n    "--no-load-session",\n    "--http-mcp",\n    "--no-additional-directories",\n    "--no-delete-session",\n    "--no-fork-session",\n    "--no-embedded-context",\n  );\n  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});\n}\n`,
        { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    try {
        await withRealDaemon(
            new DeepSeekHarnessAgentSpecification(),
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: nativeStateDirectory, PATH: executableDirectory },
            async (peer) => {
                const sessionId = await prepareNewRealSession(peer, "deepseek-harness");
                const closeRequestId = crypto.randomUUID();
                peer.send(
                    encodeSessionCloseCommand({
                        kind: "session.close",
                        requestId: closeRequestId,
                        sessionId,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "session.closed") {
                        continue;
                    }
                    expect(decodeSessionClosedEvent(message)).toEqual({
                        kind: "session.closed",
                        requestId: closeRequestId,
                        sessionId,
                    });
                    break;
                }

                const restoreRequestId = crypto.randomUUID();
                peer.send(
                    encodeSessionRestoreCommand({
                        kind: "session.restore",
                        requestId: restoreRequestId,
                        sessionId,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "session.restored") {
                        continue;
                    }
                    expect(decodeSessionRestoredEvent(message)).toMatchObject({
                        kind: "session.restored",
                        requestId: restoreRequestId,
                        ready: { sessionId },
                    });
                    break;
                }
            },
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
