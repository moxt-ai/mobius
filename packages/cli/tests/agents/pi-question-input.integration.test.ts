import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decodeSessionEvent,
    encodeSessionCancelCommand,
    encodeSessionElicitationRespondCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/agent/specification/vendors/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { piQuestionExtension } from "../support/agents/pi-question-extension.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

for (const scenario of [
    { method: "input", action: "accept", answer: "a thoughtful answer" },
    { method: "input", action: "accept", answer: "" },
    { method: "editor", action: "accept", answer: "Revised first line\n\u7b2c\u4e8c\u884c stays intact" },
    { method: "input", action: "cancel", answer: "" },
    { method: "select", action: "accept", answer: "Green" },
    { method: "confirm", action: "accept", answer: "no" },
    { method: "input", action: "stop", answer: "" },
] satisfies readonly {
    readonly method: string;
    readonly action: "accept" | "cancel" | "stop";
    readonly answer: string;
}[]) {
    test(`Given real Pi requests ${scenario.method} text, When the client sends ${scenario.action} with ${JSON.stringify(scenario.answer)}, Then Pi receives that exact outcome and continues`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-pi-question-"));
        try {
            const extensionPath = join(directory, "question.mjs");
            await writeFile(extensionPath, piQuestionExtension);
            const prompt = "Collect the answer before continuing";
            await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_CONTINUED", {
                toolPrompt: prompt,
                toolSequence: [{ name: "collect_answer", input: JSON.stringify({ method: scenario.method }) }],
            });
            await using agent = await PiFixture.create(provider);
            await agent.overrideSettings({ extensions: [extensionPath] });
            await withRealDaemon(new PiAgentSpecification(), agent.environment, async (peer) => {
                const commandId = randomUUID();
                peer.send(
                    encodeSessionPromptCommand({
                        additionalDirectoryIds: [],
                        agentId: "pi",
                        bindingId: peer.bindingId,
                        commandId,
                        directoryId: "default",
                        disposition: SessionPromptDisposition.Reject,
                        images: [],
                        kind: "session.prompt",
                        prompt,
                        resources: [],
                        sessionId: peer.sessionId,
                        targetCommandId: "",
                    }),
                );
                let requested = false;
                let output = "";
                let toolOutput = "";
                for (;;) {
                    const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
                    if (event.type === "lifecycle-metadata" && event.payload.kind === "session.elicitation.requested") {
                        const question = event.payload.event;
                        expect(question.fields).toHaveLength(1);
                        const field = question.fields[0];
                        expect(field?.type).toBe(
                            scenario.method === "select" || scenario.method === "confirm" ? "select" : "string",
                        );
                        expect(field).toHaveProperty("multiline", scenario.method === "editor");
                        expect(field?.defaultStringValue).toBe(
                            scenario.method === "editor" ? "First draft\nSecond line" : "",
                        );
                        requested = true;
                        if (scenario.action === "stop") {
                            peer.send(
                                encodeSessionCancelCommand({
                                    kind: "session.cancel",
                                    sessionId: peer.sessionId,
                                    commandId,
                                }),
                            );
                            continue;
                        }
                        peer.send(
                            encodeSessionElicitationRespondCommand({
                                kind: "session.elicitation.respond",
                                interactionId: question.interactionId,
                                sessionId: peer.sessionId,
                                action: scenario.action,
                                content: JSON.stringify({ answer: scenario.answer }),
                            }),
                        );
                    } else if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "session.permission.requested"
                    ) {
                        throw new Error("A question must use elicitation, not permission approval");
                    } else if (event.type === "acp") {
                        if (
                            event.payload.sessionUpdate === "agent_message_chunk" &&
                            event.payload.content.type === "text"
                        ) {
                            output += event.payload.content.text;
                        }
                        if (event.payload.sessionUpdate === "tool_call_update") {
                            toolOutput += JSON.stringify(event.payload);
                        }
                    } else if (
                        event.type === "lifecycle-metadata" &&
                        (event.payload.kind === "prompt.failed" || event.payload.kind === "prompt.failed-before-start")
                    ) {
                        throw new Error(JSON.stringify(event));
                    } else if (
                        event.type === "lifecycle-metadata" &&
                        event.payload.kind === "prompt.completed" &&
                        event.payload.commandId === commandId
                    ) {
                        expect(event.payload.stopReason).toBe(scenario.action === "stop" ? "cancelled" : "end_turn");
                        break;
                    }
                }
                expect(requested).toBe(true);
                if (scenario.action === "stop") {
                    return;
                }
                const value =
                    scenario.action === "accept"
                        ? { value: scenario.method === "confirm" ? false : scenario.answer }
                        : {};
                expect(toolOutput).toContain(JSON.stringify(`PI_ANSWER:${JSON.stringify(value)}`).slice(1, -1));
                expect(output).toContain("PI_CONTINUED");
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
}
