import * as p from "@moxt-ai/mobius-protocol";
import type { FakeDaemonOptions } from "./model.ts";
export const fakeDaemonCapabilities = {
    additionalDirectories: true,
    audioPrompt: false,
    closeSession: false,
    deleteSession: false,
    embeddedContextPrompt: true,
    imagePrompt: true,
    listSessions: true,
    loadSession: true,
    promptQueueing: true,
    resumeSession: true,
    steering: true,
    unstableForkSession: false,
};
export function fakeSessionReady(
    command: {
        readonly additionalDirectoryIds: readonly string[];
        readonly agentId: string;
        readonly directoryId: string;
        readonly requestId: string;
    },
    behavior: FakeDaemonOptions,
    sessionId: string,
    restored: boolean,
): p.SessionReadyEvent {
    return {
        additionalDirectories: command.additionalDirectoryIds.map((directoryId) => ({
            directoryId,
            name: directoryId,
        })),
        agentId: command.agentId,
        agentName: behavior.agentName ?? "Codex",
        agentVersion: "fake-agent-daemon",
        capabilities: fakeDaemonCapabilities,
        commands: [],
        configOptions: [],
        directoryId: command.directoryId,
        directoryLabel: "Fake workspace",
        kind: "session.ready",
        requestId: command.requestId,
        restored,
        sessionId: sessionId,
    };
}

export function settings(
    command: ReturnType<typeof p.decodeAgentSettingsDiscoverCommand>,
    behavior: FakeDaemonOptions,
): string {
    return p.encodeAgentSettingsDiscoveredEvent({
        agentId: command.agentId,
        agentName: behavior.agentName ?? "Codex",
        agentVersion: "fake-agent-daemon",
        kind: "agent.settings.discovered",
        modelEffort: {
            effortSettingId: "",
            modelSettingId: "model",
            resolution: "complete",
            unsupportedModelIds: [],
            valuesByModel: { "test-large": [], "test-small": [] },
        },
        requestId: command.requestId,
        settings: [
            {
                booleanValue: false,
                category: "model",
                defaultValue: "test-small",
                description: "Model used by the fake Agent-daemon",
                id: "model",
                name: "Model",
                type: "select",
                values: [
                    {
                        description: "Small deterministic test model",
                        groupId: "models",
                        groupName: "Models",
                        name: "Test Small",
                        value: "test-small",
                    },
                    {
                        description: "Large deterministic test model",
                        groupId: "models",
                        groupName: "Models",
                        name: "Test Large",
                        value: "test-large",
                    },
                ],
            },
        ],
        settingsRevision: "0".repeat(64),
    });
}
