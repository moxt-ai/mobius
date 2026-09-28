import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { LocalAgentDefinition } from "../../packages/cli/src/config.ts";

function findHarnessPath(): string {
    const fixture = join("tests", "agent-daemon", "fixtures", "fake-acp-agent", "src", "cli.ts");
    let directory = process.cwd();
    for (;;) {
        for (const candidate of [join(directory, fixture), join(directory, "third-party", "mobius", fixture)]) {
            if (existsSync(candidate)) {
                return candidate;
            }
        }
        const parent = dirname(directory);
        if (parent === directory || directory === parse(directory).root) {
            throw new Error("Could not locate the controlled Agent harness executable");
        }
        directory = parent;
    }
}

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
        [findHarnessPath(), "--agent-name", definition.label, ...(definition.arguments ?? [])],
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
