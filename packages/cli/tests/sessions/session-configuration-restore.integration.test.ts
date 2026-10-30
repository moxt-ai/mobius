import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    decodeMessageKind,
    decodeSessionConfigUpdatedEvent,
    decodeSessionLiveEvent,
    decodeSessionReadyEvent,
    encodeSessionCloseCommand,
    encodeSessionConfigureCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { ControlledAcpSpecification } from "../support/agents/controlled-acp-specification.ts";
import { prepareNewRealSession, type RealDaemonPeer, withControlledDaemon } from "../support/agents/real-daemon.ts";

class ModelDependentSettingsAgent extends ControlledAcpSpecification {
    readonly adapterVersion = process.versions.node;
    readonly agentExecutable = "node";
    readonly id = "controlled-acp";
    readonly label = "Controlled model-dependent settings";
    override readonly maximumTestedAgentVersion = process.versions.node;
    override readonly minimumSupportedAgentVersion = process.versions.node;

    constructor() {
        super("MOBIUS_TEST_MODEL_DEPENDENT_SETTINGS_PATH", [
            fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url)),
            "--reasoning-effort-for-test-large-only",
            "--recover-default-settings",
        ]);
    }
}

test("Given effort was chosen before the model it depends on, When the conversation reopens in a new Agent process, Then both settings are restored", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-config-restore-"));
    try {
        await withControlledDaemon(
            new ModelDependentSettingsAgent(),
            {
                MOBIUS_TEST_MODEL_DEPENDENT_SETTINGS_PATH: process.execPath,
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: directory,
            },
            async (peer) => {
                const sessionId = await prepareNewRealSession(peer, "controlled-acp");
                await prompt(peer, sessionId);
                let revision = await configure(peer, sessionId, "model", "test-large", "");
                revision = await configure(peer, sessionId, "reasoning_effort", "high", revision);
                // Trying another model and returning makes the model the latest edit.
                revision = await configure(peer, sessionId, "model", "test-small", revision);
                await configure(peer, sessionId, "model", "test-large", revision);

                await close(peer, sessionId);
                expect(await prepare(peer, sessionId)).toEqual(
                    expect.arrayContaining([
                        expect.objectContaining({ id: "model", currentValue: "test-large" }),
                        expect.objectContaining({ id: "reasoning_effort", currentValue: "high" }),
                    ]),
                );
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

const identity = (peer: RealDaemonPeer) => ({
    additionalDirectoryIds: [],
    agentId: "controlled-acp",
    bindingId: peer.bindingId,
    directoryId: "default",
});

async function prompt(peer: RealDaemonPeer, sessionId: string): Promise<void> {
    peer.send(
        encodeSessionPromptCommand({
            ...identity(peer),
            attachments: [],
            commandId: crypto.randomUUID(),
            disposition: SessionPromptDisposition.Reject,
            kind: "session.prompt",
            prompt: "Start the conversation",
            sessionId,
            targetCommandId: "",
        }),
    );
    for (;;) {
        const event = decodeSessionLiveEvent(JSON.parse(await peer.nextEvent()));
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
            throw new Error(JSON.stringify(event));
        }
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
            return;
        }
    }
}

async function prepare(peer: RealDaemonPeer, sessionId: string) {
    const requestId = crypto.randomUUID();
    peer.send(encodeSessionPrepareCommand({ ...identity(peer), kind: "session.prepare", requestId, sessionId }));
    for (;;) {
        const message = await nextMessage(peer, "session.ready");
        const ready = decodeSessionReadyEvent(message);
        if (ready.requestId === requestId) {
            return ready.configOptions;
        }
    }
}

/** Changes one setting as the Web does and returns the revision the next change must name. */
async function configure(
    peer: RealDaemonPeer,
    sessionId: string,
    configId: string,
    value: string,
    expectedRevision: string,
): Promise<string> {
    const revision = expectedRevision.length > 0 ? expectedRevision : await currentRevision(peer, sessionId);
    const requestId = crypto.randomUUID();
    peer.send(
        encodeSessionConfigureCommand({
            ...identity(peer),
            booleanValue: false,
            configId,
            expectedConfigurationRevision: revision,
            kind: "session.configure",
            requestId,
            sessionId,
            value,
            valueType: "select",
        }),
    );
    for (;;) {
        const updated = decodeSessionConfigUpdatedEvent(await nextMessage(peer, "session.config.updated"));
        if (updated.requestId === requestId) {
            return updated.configurationRevision;
        }
    }
}

async function currentRevision(peer: RealDaemonPeer, sessionId: string): Promise<string> {
    const requestId = crypto.randomUUID();
    peer.send(encodeSessionPrepareCommand({ ...identity(peer), kind: "session.prepare", requestId, sessionId }));
    for (;;) {
        const ready = decodeSessionReadyEvent(await nextMessage(peer, "session.ready"));
        if (ready.requestId === requestId) {
            return ready.configurationRevision;
        }
    }
}

async function close(peer: RealDaemonPeer, sessionId: string): Promise<void> {
    const requestId = crypto.randomUUID();
    peer.send(encodeSessionCloseCommand({ kind: "session.close", requestId, sessionId }));
    await nextMessage(peer, "session.closed");
}

async function nextMessage(peer: RealDaemonPeer, expectedKind: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === expectedKind) {
            return message;
        }
        if (kind === "session.operation.failed") {
            throw new Error(`Unexpected ${kind}: ${message}`);
        }
    }
}
