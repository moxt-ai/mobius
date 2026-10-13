import { randomUUID } from "node:crypto";

import {
    decodeMessageKind,
    decodeSessionSettingsLoadedV3,
    encodeSessionPromptCommand,
    encodeSessionSettingChangeV3,
    encodeSessionSettingsReadV3,
    type SessionLiveEventV3,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { PiAgentSpecification } from "../../src/agent-catalog/agents/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { prepareNewRealSession, withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

test("Given a real Pi CLI and a prepared direct Session, When settings change and Pi answers, Then settings, native content, and lifecycle cross the public daemon protocol in sequence", async () => {
    await using provider = await FakeOpenAiProvider.start("gpt-4.1", "PI_V3_REPLY");
    await using agent = await PiFixture.create(provider);
    await withRealDaemon(
        new PiAgentSpecification(),
        agent.environment,
        async (peer) => {
            const sessionId = await prepareNewRealSession(peer, "pi");
            const events: SessionLiveEventV3[] = [await peer.nextLiveEventV3()];
            expect(events[0]).toMatchObject({
                item: { sessionUpdate: "session_lifecycle_changed", state: { kind: "connected" } },
                seq: 1,
                sessionId,
            });

            const readRequestId = randomUUID();
            peer.send(
                encodeSessionSettingsReadV3({
                    kind: "session.settings.v3.read",
                    requestId: readRequestId,
                    sessionId,
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.settings.v3.loaded") {
                    continue;
                }
                const loaded = decodeSessionSettingsLoadedV3(message);
                if (loaded.requestId === readRequestId) {
                    expect(loaded.settings.settings).toEqual(
                        expect.arrayContaining([expect.objectContaining({ id: "thinking_level", value: "off" })]),
                    );
                    break;
                }
            }

            const changeRequestId = randomUUID();
            peer.send(
                encodeSessionSettingChangeV3({
                    kind: "session.setting.v3.change",
                    requestId: changeRequestId,
                    sessionId,
                    settingId: "thinking_level",
                    value: "medium",
                }),
            );
            for (;;) {
                const message = await peer.nextMessage();
                if (decodeMessageKind(message) !== "session.settings.v3.loaded") {
                    continue;
                }
                const loaded = decodeSessionSettingsLoadedV3(message);
                if (loaded.requestId === changeRequestId) {
                    expect(loaded.settings.settings).toEqual(
                        expect.arrayContaining([expect.objectContaining({ id: "thinking_level", value: "off" })]),
                    );
                    break;
                }
            }
            events.push(await peer.nextLiveEventV3());
            expect(events.at(-1)).toMatchObject({
                item: { sessionUpdate: "session_settings_changed" },
                seq: 2,
                sessionId,
            });

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
                    prompt: "Answer through the direct Pi Session",
                    resources: [],
                    sessionId,
                    targetCommandId: "",
                }),
            );
            let answer = "";
            for (;;) {
                const event = await peer.nextLiveEventV3();
                events.push(event);
                if (event.item.sessionUpdate === "agent_message_chunk" && event.item.content.type === "text") {
                    answer += event.item.content.text;
                }
                if (event.item.sessionUpdate === "session_lifecycle_changed" && event.item.state.kind === "idle") {
                    break;
                }
            }
            expect(answer).toContain("PI_V3_REPLY");
            expect(events.map((event) => event.seq)).toEqual(
                Array.from({ length: events.length }, (_value, index) => index + 1),
            );
        },
        { nativeSessionV3: true },
    );
});
