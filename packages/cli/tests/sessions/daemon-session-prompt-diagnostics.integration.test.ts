import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    decodeMessageKind,
    decodeRuntimeDiagnosticsResult,
    decodeSessionEvent,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ControlledAcpAgentSpecification } from "../support/agents/controlled-acp.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

// @no-uc: Technical regression; a failed turn must leave a correlated local trace without exporting message text.
test("Given an Agent rejects a turn, When the turn fails, Then the local diagnostic log keeps the correlated failure with its reason while the exported report stays free of message text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-prompt-diagnostics-"));
    const executableDirectory = await writeControlledAcpExecutable(directory);
    try {
        await withRealDaemon(
            new ControlledAcpAgentSpecification(),
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(directory, "agent-state"),
                PATH: executableDirectory,
            },
            async (peer) => {
                const identity = {
                    additionalDirectoryIds: [],
                    agentId: "controlled-acp",
                    bindingId: peer.bindingId,
                    directoryId: "default",
                };
                const prepareId = randomUUID();
                peer.send(
                    encodeSessionPrepareCommand({
                        ...identity,
                        kind: "session.prepare",
                        requestId: prepareId,
                        sessionId: peer.sessionId,
                    }),
                );
                for (;;) {
                    if (decodeMessageKind(await peer.nextMessage()) === "session.ready") {
                        break;
                    }
                }

                const commandId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        ...identity,
                        commandId,
                        disposition: SessionPromptDisposition.Reject,
                        images: [],
                        kind: "session.prompt",
                        prompt: "fail with model unavailable",
                        resources: [],
                        sessionId: peer.sessionId,
                        targetCommandId: "",
                    }),
                );
                for (;;) {
                    const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                    if (
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                    ) {
                        expect(event.payload.commandId).toBe(commandId);
                        break;
                    }
                }

                // The daemon runs detached with its stdio ignored, so the local log
                // is the only place this failure survives for a later bug report.
                const local = await peer.readDiagnostics();
                expect(local).toContain('"event":"session_prompt_failed"');
                expect(local).toContain(`"commandId":"${commandId}"`);
                expect(local).toContain(`"sessionId":"${peer.sessionId}"`);
                expect(local).toContain('"code":"acp_agent_error"');
                expect(local).toContain("Model unavailable: controlled/test-model");

                peer.send(JSON.stringify({ kind: "runtime.diagnostics.read", requestId: "turn-failure-report" }));
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "runtime.diagnostics.result") {
                        continue;
                    }
                    const exported = decodeRuntimeDiagnosticsResult(message);
                    expect(exported.requestId).toBe("turn-failure-report");
                    expect(exported.entries).toContainEqual(
                        expect.objectContaining({
                            code: "acp_agent_error",
                            commandId,
                            event: "session_prompt_failed",
                            sessionId: peer.sessionId,
                        }),
                    );
                    // The Agent's own failure text is local-only: the report carries
                    // correlation identifiers and codes, not message bodies.
                    const encoded = JSON.stringify(exported);
                    expect(encoded).not.toContain("Model unavailable: controlled/test-model");
                    expect(encoded).not.toContain(peer.workspace);
                    break;
                }
            },
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}, 120_000);
