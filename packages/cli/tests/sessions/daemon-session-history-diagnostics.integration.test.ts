import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    decodeMessageKind,
    decodeSessionOperationFailedEvent,
    encodeSessionLiveHistoryV2PageLoad,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { OpenCodeAgentSpecification } from "../../src/agent-catalog/agents/opencode-agent.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

test("Given an ACP Agent fails to load native history, When Chat requests V2 history, Then the public failure has a correlated local diagnostic with the sanitized cause chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-history-diagnostics-"));
    const executableDirectory = join(directory, "bin");
    const executable = join(executableDirectory, "opencode");
    await mkdir(executableDirectory);
    await writeFile(
        executable,
        `#!${process.execPath}
if (process.argv.includes("--version")) {
  process.stdout.write("1.18.29\\n");
} else {
  process.argv.push(
    "--agent-name", "OpenCode",
    "--agent-version", "1.18.29",
    "--http-mcp",
    "--no-additional-directories",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context",
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`,
        { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    try {
        await withRealDaemon(
            new OpenCodeAgentSpecification(),
            {
                MOBIUS_FAKE_ACP_FAIL_HISTORY_LOAD: "1",
                PATH: executableDirectory,
            },
            async (peer) => {
                peer.send(
                    encodeSessionPrepareCommand({
                        additionalDirectoryIds: [],
                        agentId: "opencode",
                        bindingId: peer.bindingId,
                        directoryId: "default",
                        kind: "session.prepare",
                        requestId: "prepare-history-session",
                        sessionId: peer.sessionId,
                    }),
                );
                for (;;) {
                    if (decodeMessageKind(await peer.nextMessage()) === "session.ready") {
                        break;
                    }
                }

                peer.send(
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "opencode",
                        bindingId: peer.bindingId,
                        commandId: "history-seed-turn",
                        directoryId: "default",
                        disposition: SessionPromptDisposition.Reject,
                        images: [],
                        kind: "session.prompt",
                        prompt: "Seed native history",
                        resources: [],
                        sessionId: peer.sessionId,
                        targetCommandId: "",
                    }),
                );
                for (;;) {
                    const event = await peer.nextEvent();
                    if (decodeMessageKind(event) === "session.completed") {
                        break;
                    }
                }

                const requestId = "load-v2-history-with-agent-failure";
                peer.send(
                    encodeSessionLiveHistoryV2PageLoad({
                        additionalDirectoryIds: [],
                        agentId: "opencode",
                        bindingId: peer.bindingId,
                        cursor: null,
                        directoryId: "default",
                        eventLimit: 50,
                        kind: "session.live-history.v2.page.load",
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
                    code: "acp_agent_error",
                    requestId,
                    sessionId: peer.sessionId,
                });
                const diagnostics = await peer.readDiagnostics();
                expect(diagnostics).toContain(`"event":"session_history_v2_load_failed"`);
                expect(diagnostics).toContain(`"requestId":"${requestId}"`);
                expect(diagnostics).toContain(`"sessionId":"${peer.sessionId}"`);
                expect(diagnostics).toContain(`"failureName":"AcpExecutionError"`);
                expect(diagnostics).toContain(`"cause1Name":"RequestError"`);
                expect(diagnostics).toContain(`"cause1Code":"-32603"`);
            },
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
