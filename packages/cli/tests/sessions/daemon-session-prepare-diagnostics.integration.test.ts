import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    decodeMessageKind,
    decodeSessionOperationFailedEvent,
    encodeSessionPrepareCommand,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { DeepSeekHarnessAgentSpecification } from "../../src/agent-catalog/discover-local-agents.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

test("Given an ACP Agent repeatedly fails Runtime initialization, When a conversation is prepared, Then the public failure has a correlated local diagnostic with the sanitized cause chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-prepare-diagnostics-"));
    const executableDirectory = join(directory, "bin");
    const executable = join(executableDirectory, "dsh");
    await mkdir(executableDirectory);
    await writeFile(
        executable,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.1.5-rc.3\\n");
} else {
  process.argv.push(
    "--agent-name", "DeepSeek Harness",
    "--agent-version", "0.1.5-rc.3",
    "--no-load-session",
    "--http-mcp",
    "--no-additional-directories",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    try {
        await withRealDaemon(
            new DeepSeekHarnessAgentSpecification(),
            {
                MOBIUS_FAKE_ACP_ALWAYS_FAIL_RUNTIME_INITIALIZATION: "1",
                MOBIUS_FAKE_ACP_FAIL_RUNTIME_INITIALIZATION: "DeepSeek Harness",
                PATH: executableDirectory,
            },
            async (peer) => {
                const requestId = "prepare-with-agent-initialization-failure";
                peer.send(
                    encodeSessionPrepareCommand({
                        additionalDirectoryIds: [],
                        agentId: "deepseek-harness",
                        bindingId: peer.bindingId,
                        directoryId: "default",
                        kind: "session.prepare",
                        requestId,
                        sessionId: peer.sessionId,
                    }),
                );
                let failure: ReturnType<typeof decodeSessionOperationFailedEvent>;
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) === "session.operation.failed") {
                        failure = decodeSessionOperationFailedEvent(message);
                        break;
                    }
                }
                expect(failure).toMatchObject({
                    code: "acp_execution_failed",
                    requestId,
                    sessionId: peer.sessionId,
                });
                const diagnostics = await peer.readDiagnostics();
                expect(diagnostics).toContain(`"event":"session_prepare_failed"`);
                expect(diagnostics).toContain(`"requestId":"${requestId}"`);
                expect(diagnostics).toContain(`"sessionId":"${peer.sessionId}"`);
                expect(diagnostics).toContain(`"failureName":"RetryableAcpInitializationError"`);
                expect(diagnostics).toContain(`"cause1Name":"AcpExecutionError"`);
                expect(diagnostics).toContain(`"cause1Message":"Persistent fake ACP initialization failure"`);
                expect(diagnostics).toContain(`"cause2Name":"RequestError"`);
                expect(diagnostics).toContain(`"cause2Message":"Internal error"`);
                expect(diagnostics).toContain(`"cause2Code":"-32603"`);
            },
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
