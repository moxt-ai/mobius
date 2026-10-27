import { fileURLToPath } from "node:url";
import { AcpAgentDefinition } from "../../src/acp/agent/agent-definition.ts";
import { ControlledAcpConnection } from "./agents/controlled-acp-connection.ts";

const harnessPath = fileURLToPath(new URL("../sessions/fixtures/acp-peer.ts", import.meta.url));

export interface FakeAgentHarnessDefinition {
    readonly id: string;
    readonly label: string;
    readonly arguments?: readonly string[];
}

export function fakeAgentHarnessCapabilities(definition: FakeAgentHarnessDefinition) {
    return {
        additionalDirectories: true,
        audioPrompt: false,
        closeSession: true,
        deleteSession: true,
        embeddedContextPrompt: true,
        imagePrompt: true,
        listSessions: true,
        loadSession: true,
        promptQueueing: true,
        renameSession: !(definition.arguments ?? []).includes("--no-rename-session"),
        resumeSession: !(definition.arguments ?? []).includes("--load-only"),
        steering: true,
        unstableForkSession: true,
    };
}

/** A controlled Agent executable behind the production daemon and ACP adapter. */
export function fakeAgentHarness(definition: FakeAgentHarnessDefinition, stateDirectory: string): AcpAgentDefinition {
    return new AcpAgentDefinition(
        definition.id,
        definition.label,
        process.execPath,
        (options) =>
            new ControlledAcpConnection(
                {
                    id: definition.id,
                    adapterPath: process.execPath,
                    arguments: [harnessPath, "--agent-name", definition.label, ...(definition.arguments ?? [])],
                    environment: options.environment,
                },
                options,
            ),
        { MOBIUS_FAKE_ACP_STATE_DIRECTORY: stateDirectory },
        "1.0.0",
        undefined,
        fakeAgentHarnessCapabilities(definition),
        "1.0.0",
    );
}

export const defaultFakeAgentHarness: FakeAgentHarnessDefinition = {
    arguments: ["--load-only"],
    id: "claude",
    label: "Codex",
};
