import { fileURLToPath } from "node:url";
import {
    decodeMessageKind,
    decodeSessionConfigUpdatedEvent,
    decodeSessionReadyEvent,
    encodeSessionConfigureCommand,
    encodeSessionPrepareCommand,
} from "@moxt-ai/mobius-sdk/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";
import { withControlledDaemon } from "../support/agents/real-daemon.ts";

afterEach(() => vi.useRealTimers());

class UpdatingSettingsAgent extends ControlledAcpSpecification {
    readonly adapterVersion = process.versions.node;
    readonly agentExecutable = "node";
    readonly id = "controlled-acp";
    readonly label = "Controlled session state";
    override readonly maximumTestedAgentVersion = process.versions.node;
    override readonly minimumSupportedAgentVersion = process.versions.node;

    constructor(stage: "opening" | "configuration") {
        super("MOBIUS_TEST_SESSION_STATE_PATH", [
            fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url)),
            stage === "opening"
                ? "--announce-newer-settings-while-creating"
                : "--announce-newer-settings-while-configuring",
        ]);
    }
}

test.each(["opening", "configuration"] as const)(
    "Given an Agent updates settings before its %s response, When the client operation completes, Then the returned settings preserve the newer model, mode, and speed",
    async (stage) => {
        vi.useFakeTimers({ now: new Date("2026-10-29T00:00:00Z"), toFake: ["Date"] });
        await withControlledDaemon(
            new UpdatingSettingsAgent(stage),
            { MOBIUS_TEST_SESSION_STATE_PATH: process.execPath },
            async (peer) => {
                const requestId = crypto.randomUUID();
                peer.send(
                    encodeSessionPrepareCommand({
                        kind: "session.prepare",
                        agentId: "controlled-acp",
                        bindingId: peer.bindingId,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                        sessionId: peer.sessionId,
                        requestId,
                    }),
                );
                for (;;) {
                    const message = await peer.nextMessage();
                    const kind = decodeMessageKind(message);
                    if (kind === "session.operation.failed") {
                        throw new Error(message);
                    }
                    if (kind !== "session.ready") {
                        continue;
                    }
                    const ready = decodeSessionReadyEvent(message);
                    expect(ready.requestId).toBe(requestId);
                    let configOptions = ready.configOptions;
                    if (stage === "configuration") {
                        const configureId = crypto.randomUUID();
                        peer.send(
                            encodeSessionConfigureCommand({
                                kind: "session.configure",
                                agentId: "controlled-acp",
                                bindingId: peer.bindingId,
                                directoryId: "default",
                                additionalDirectoryIds: [],
                                sessionId: peer.sessionId,
                                requestId: configureId,
                                configId: "model",
                                valueType: "select",
                                value: "test-large",
                                booleanValue: false,
                            }),
                        );
                        for (;;) {
                            const message = await peer.nextMessage();
                            const kind = decodeMessageKind(message);
                            if (kind === "session.operation.failed") {
                                throw new Error(message);
                            }
                            if (kind !== "session.config.updated") {
                                continue;
                            }
                            const configured = decodeSessionConfigUpdatedEvent(message);
                            if (configured.requestId === configureId) {
                                configOptions = configured.configOptions;
                                break;
                            }
                        }
                    }
                    expect(configOptions).toEqual(
                        expect.arrayContaining([
                            expect.objectContaining({ id: "model", currentValue: "test-large" }),
                            expect.objectContaining({ id: "mode", currentValue: "plan" }),
                            expect.objectContaining({ id: "fast_mode", booleanValue: true }),
                        ]),
                    );
                    return;
                }
            },
        );
    },
);
