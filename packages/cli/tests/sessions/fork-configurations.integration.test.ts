import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionLiveEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    encodeNativeSessionCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";
import { type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";

class ForkSettingsAgent extends ControlledAcpSpecification {
    readonly adapterVersion = process.versions.node;
    readonly agentExecutable = "node";
    readonly id = "controlled-acp";
    readonly label = "Controlled Fork settings";
    override readonly maximumTestedAgentVersion = process.versions.node;
    override readonly minimumSupportedAgentVersion = process.versions.node;

    constructor(fault: string) {
        super("MOBIUS_TEST_FORK_SETTINGS_PATH", [
            fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url)),
            "--reset-fork-settings",
            ...(fault.length === 0 ? [] : [fault]),
        ]);
    }
}

test.each(["", "--fork-mode-unavailable", "--fork-omits-mode"])(
    "Given source selections and a Fork Agent %s, When a retained client forks, Then settings are inherited or the Fork fails without changing its source",
    async (fault) => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-fork-settings-"));
        try {
            await withControlledDaemon(
                new ForkSettingsAgent(fault),
                {
                    MOBIUS_TEST_FORK_SETTINGS_PATH: process.execPath,
                    MOBIUS_FAKE_ACP_STATE_DIRECTORY: directory,
                },
                async (peer) => {
                    const identity = {
                        agentId: "controlled-acp",
                        bindingId: peer.bindingId,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                    };
                    peer.send(
                        encodeSessionPromptCommand({
                            ...identity,
                            kind: "session.prompt",
                            sessionId: peer.sessionId,
                            commandId: crypto.randomUUID(),
                            prompt: "Keep these source settings",
                            attachments: [],
                            disposition: SessionPromptDisposition.Reject,
                            targetCommandId: "",
                            sessionConfigurations: [
                                { configId: "mode", valueType: "select", value: "plan", booleanValue: false },
                                { configId: "model", valueType: "select", value: "test-large", booleanValue: false },
                                { configId: "fast_mode", valueType: "boolean", value: "", booleanValue: true },
                            ],
                        }),
                    );
                    for (;;) {
                        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
                            throw new Error(JSON.stringify(event));
                        }
                        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
                            break;
                        }
                    }
                    const listId = crypto.randomUUID();
                    peer.send(
                        encodeNativeSessionCommand({
                            ...identity,
                            kind: "native.session.request",
                            action: "list",
                            sessionId: peer.sessionId,
                            requestId: listId,
                            cursor: null,
                        }),
                    );
                    const list = decodeNativeSessionResult(await nextMessage(peer, "native.session.result"));
                    if (list.action !== "list" || list.entries[0] === undefined) {
                        throw new Error("Missing native source");
                    }
                    const childId = crypto.randomUUID();
                    const requestId = crypto.randomUUID();
                    // Retained pre-receipt Runtime wire request: no new fields or negotiation required.
                    peer.send(
                        JSON.stringify({
                            ...identity,
                            kind: "native.session.request",
                            action: "fork",
                            sessionId: peer.sessionId,
                            requestId,
                            entryId: list.entries[0].entryId,
                            targetSessionId: childId,
                        }),
                    );
                    const selections = [
                        expect.objectContaining({ id: "mode", currentValue: "plan" }),
                        expect.objectContaining({ id: "model", currentValue: "test-large" }),
                        expect.objectContaining({ id: "fast_mode", booleanValue: true }),
                    ];
                    if (fault.length > 0) {
                        const failure = decodeSessionOperationFailedEvent(
                            await nextMessage(peer, "session.operation.failed"),
                        );
                        expect(failure).toMatchObject({ requestId, code: "invalid_session_configuration" });
                    } else {
                        const fork = decodeNativeSessionResult(await nextMessage(peer, "native.session.result"));
                        expect(fork).toMatchObject({
                            action: "fork",
                            requestId,
                            ready: { sessionId: childId, configOptions: expect.arrayContaining(selections) },
                        });
                    }
                    peer.send(
                        encodeSessionPrepareCommand({
                            ...identity,
                            kind: "session.prepare",
                            requestId: crypto.randomUUID(),
                            sessionId: peer.sessionId,
                        }),
                    );
                    expect(decodeSessionReadyEvent(await nextMessage(peer, "session.ready")).configOptions).toEqual(
                        expect.arrayContaining(selections),
                    );
                },
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);

async function nextMessage(peer: RealDaemonPeer, expectedKind: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === expectedKind) {
            return message;
        }
        if (kind === "session.operation.failed" || kind === "native.session.result") {
            throw new Error(`Unexpected ${kind}: ${message}`);
        }
    }
}
