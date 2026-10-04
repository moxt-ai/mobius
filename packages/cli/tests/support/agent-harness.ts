import { fileURLToPath } from "node:url";
import { LocalAgentDefinition } from "../../src/config.ts";

const harnessPath = fileURLToPath(new URL("./acp/fake-acp-agent/src/cli.ts", import.meta.url));

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
        resumeSession: !(definition.arguments ?? []).includes("--load-only"),
        steering: true,
        unstableForkSession: true,
    };
}

/** A controlled Agent executable behind the production daemon and ACP adapter. */
export function fakeAgentHarness(definition: FakeAgentHarnessDefinition, stateDirectory: string): LocalAgentDefinition {
    return new LocalAgentDefinition(
        definition.id,
        definition.label,
        process.execPath,
        [harnessPath, "--agent-name", definition.label, ...(definition.arguments ?? [])],
        { MOBIUS_FAKE_ACP_STATE_DIRECTORY: stateDirectory },
        "1.0.0",
        "1.0.0",
        undefined,
        undefined,
        fakeAgentHarnessCapabilities(definition),
    );
}

export const defaultFakeAgentHarness: FakeAgentHarnessDefinition = {
    arguments: ["--load-only"],
    id: "claude",
    label: "Codex",
};
