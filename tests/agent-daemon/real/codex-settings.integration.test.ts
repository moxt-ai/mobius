import { randomUUID } from "node:crypto";
import {
    decodeAgentSettingsDiscoveredEvent,
    decodeMessageKind,
    decodeRecordedSessionEvent,
    encodeAgentSettingsDiscoverCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { CodexAgentSpecification } from "../../../packages/cli/src/agent-catalog/agents/codex-agent.ts";
import { CodexFixture } from "../infra/codex.ts";
import { withRealDaemon } from "../infra/real-daemon.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";

test("Given real Codex advertises its settings, When a user selects a model and reasoning effort, Then the LLM receives those settings and the conversation answers", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "SETTINGS_REPLY");
    await using codex = await CodexFixture.create(provider);
    await withRealDaemon(new CodexAgentSpecification(), codex.environment, async (peer) => {
        const requestId = randomUUID();
        peer.send(encodeAgentSettingsDiscoverCommand({ kind: "agent.settings.discover", agentId: "codex", requestId }));
        let discovered: ReturnType<typeof decodeAgentSettingsDiscoveredEvent>;
        for (;;) {
            const message = await peer.nextMessage();
            if (decodeMessageKind(message) === "agent.settings.discovered") {
                discovered = decodeAgentSettingsDiscoveredEvent(message);
                break;
            }
        }
        expect(discovered.requestId).toBe(requestId);
        const model = discovered.settings.find((setting) => setting.id === "model")?.values[0]?.value;
        const effort = discovered.settings
            .find((setting) => setting.id === "reasoning_effort")
            ?.values.find((option) => option.value === "high")?.value;
        if (model === undefined || effort === undefined) {
            throw new Error("Codex did not advertise model/effort settings");
        }
        expect(discovered.settings.find((setting) => setting.id === "fast-mode")).toMatchObject({ type: "boolean" });
        expect(discovered.settings.find((setting) => setting.id === "collaboration_mode")?.values).toContainEqual(
            expect.objectContaining({ value: "plan" }),
        );
        peer.send(
            encodeSessionPromptCommand({
                kind: "session.prompt",
                commandId: randomUUID(),
                sessionId: peer.sessionId,
                agentId: "codex",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
                images: [],
                resources: [],
                prompt: "Reply with the selected settings",
                disposition: SessionPromptDisposition.Reject,
                targetCommandId: "",
                sessionConfigurations: [
                    { configId: "model", valueType: "select", value: model, booleanValue: false },
                    { configId: "reasoning_effort", valueType: "select", value: effort, booleanValue: false },
                    { configId: "mode", valueType: "select", value: "agent-full-access", booleanValue: false },
                    { configId: "fast-mode", valueType: "boolean", value: "", booleanValue: true },
                    { configId: "collaboration_mode", valueType: "select", value: "plan", booleanValue: false },
                ],
            }),
        );
        let text = "";
        for (;;) {
            const event = decodeRecordedSessionEvent(await peer.nextEvent());
            if (event.kind === "session.failed") {
                throw new Error(JSON.stringify(event));
            }
            if (event.kind === "agent.message.delta") {
                text += event.text;
            }
            if (event.kind === "session.completed") {
                break;
            }
        }
        expect(text).toContain("SETTINGS_REPLY");
        expect(provider.diagnostics()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    model,
                    reasoning: expect.objectContaining({ effort }),
                    serviceTier: "priority",
                }),
            ]),
        );
    });
});
