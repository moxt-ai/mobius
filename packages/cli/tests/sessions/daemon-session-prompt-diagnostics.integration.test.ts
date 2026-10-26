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
import { withControlledDaemon as withRealDaemon } from "../support/agents/real-daemon.ts";
import { writeControlledAcpExecutable } from "../support/controlled-acp-executable.ts";

// @no-uc: Technical regression; a failed turn must leave a correlated local trace without persisting Agent free text.
test("Given an Agent rejects a turn, When the turn fails, Then the failure event carries the reason to the user while neither the local log nor the exported report persists it", async () => {
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
                // The Agent quotes the refused prompt back in its error message, so
                // this is exactly the path by which user input reaches a diagnostic.
                const promptText = "CANARY-prompt-body-9f3a";
                const prompt = `fail echoing the prompt ${promptText}`;
                peer.send(
                    encodeSessionPromptCommand({
                        ...identity,
                        commandId,
                        disposition: SessionPromptDisposition.Reject,
                        images: [],
                        kind: "session.prompt",
                        prompt,
                        resources: [],
                        sessionId: peer.sessionId,
                        targetCommandId: "",
                    }),
                );
                let failureMessage: string | undefined;
                for (;;) {
                    const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                    if (
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                    ) {
                        expect(event.payload.commandId).toBe(commandId);
                        failureMessage = event.payload.message;
                        break;
                    }
                }
                // The Agent's reason still reaches the user in-band through the
                // failure event, so dropping it from the local log loses nothing
                // the user sees. Confirm the quoted prompt did arrive here.
                expect(failureMessage).toContain(promptText);

                // The daemon runs detached with its stdio ignored, so the local log
                // is the only place this failure survives for a later bug report.
                const local = await peer.readDiagnostics();
                expect(local).toContain('"event":"session_prompt_failed"');
                expect(local).toContain(`"commandId":"${commandId}"`);
                expect(local).toContain(`"sessionId":"${peer.sessionId}"`);
                expect(local).toContain('"code":"acp_agent_error"');
                // Local diagnostics must not contain prompt text: the quoted prompt
                // and the Agent's free text both stay out of the persisted log.
                expect(local).not.toContain(promptText);
                expect(local).not.toContain("Rejected prompt:");

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
                    // The exported report carries correlation identifiers and codes,
                    // not message bodies, and the quoted prompt stays out of it too.
                    const encoded = JSON.stringify(exported);
                    expect(encoded).not.toContain(promptText);
                    expect(encoded).not.toContain("Rejected prompt:");
                    expect(encoded).not.toContain(peer.workspace);
                    break;
                }
            },
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}, 120_000);
