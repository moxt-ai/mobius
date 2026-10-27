import { randomUUID } from "node:crypto";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionEvent,
    decodeSessionOperationFailedEvent,
    encodeNativeSessionCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { z } from "zod";
import { CodexAgentSpecification } from "../../src/agent/specification/vendors/codex-agent.ts";
import { executableLaunch, runBoundedProcess } from "../../src/util/process/executable.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given setup runs in a real Codex exec conversation, When its native session is found and imported, Then the user can continue chatting through the daemon", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "CODEX_INSTALL_HANDOFF_REPLY");
    await using codex = await CodexFixture.create(provider, { configuredModel: provider.model });
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const launch = executableLaunch(codex.executable, [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "danger-full-access",
            "Keep this conversation available for the installation handoff",
        ]);
        const seeded = await runBoundedProcess({
            command: launch.command,
            arguments: launch.arguments,
            cwd: peer.workspace,
            environment: { ...process.env, ...codex.environment },
            signal: peer.signal,
            timeoutMilliseconds: 30_000,
            outputLimitBytes: 1_048_576,
        });
        const started = z.object({ type: z.literal("thread.started"), thread_id: z.string().min(1) });
        const nativeSessionId = seeded.stdout
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => started.safeParse(JSON.parse(line)))
            .find((result) => result.success)?.data?.thread_id;
        if (nativeSessionId === undefined) {
            throw new Error(`Native Codex did not report its session ID: ${seeded.stdout}`);
        }

        const identity = {
            additionalDirectoryIds: [],
            agentId: "codex",
            bindingId: peer.bindingId,
            directoryId: "default",
            kind: "native.session.request",
            sessionId: randomUUID(),
        } as const;
        const nextResult = async (requestId: string) => {
            for (;;) {
                const message = await peer.nextMessage();
                const kind = decodeMessageKind(message);
                if (kind === "session.operation.failed") {
                    throw new Error(JSON.stringify(decodeSessionOperationFailedEvent(message)));
                }
                if (kind === "native.session.result") {
                    const result = decodeNativeSessionResult(message);
                    if (result.requestId === requestId) {
                        return result;
                    }
                }
            }
        };
        const findRequestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "find",
                nativeSessionId,
                requestId: findRequestId,
            }),
        );
        const found = await nextResult(findRequestId);
        if (found.action !== "find") {
            throw new Error("Expected the native handoff session");
        }
        expect(found.entry.nativeSessionId).toBe(nativeSessionId);

        const sessionId = randomUUID();
        const importRequestId = randomUUID();
        peer.send(
            encodeNativeSessionCommand({
                ...identity,
                action: "import",
                entryId: found.entry.entryId,
                requestId: importRequestId,
                targetSessionId: sessionId,
            }),
        );
        const imported = await nextResult(importRequestId);
        expect(imported).toMatchObject({ action: "import", ready: { restored: true }, targetSessionId: sessionId });

        const commandId = randomUUID();
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId,
                sessionId,
                agentId: "codex",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
                attachments: [],
                prompt: "Continue this conversation after installation",
                disposition: SessionPromptDisposition.Reject,
                targetCommandId: "",
            }),
        );
        let reply = "";
        for (;;) {
            const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
            if (
                event.type === "acp" &&
                event.payload.sessionUpdate === "agent_message_chunk" &&
                event.payload.content.type === "text"
            ) {
                reply += event.payload.content.text;
            }
            if (
                event.type === "lifecycle-metadata" &&
                (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.completed") &&
                event.payload.commandId === commandId
            ) {
                if (event.payload.kind === "prompt.failed") {
                    throw new Error(JSON.stringify(event));
                }
                if (event.payload.kind === "prompt.completed") {
                    expect(reply).toContain("CODEX_INSTALL_HANDOFF_REPLY");
                    break;
                }
            }
        }
    });
});
