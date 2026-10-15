import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_INSTALL_REQUEST_KIND, type AgentInstallRequestCommand } from "@moxt-ai/mobius-protocol";
import { expect, it } from "vitest";
import { CodexAgentSpecification } from "../../src/agent-catalog/discover-local-agents.ts";
import {
    LocalAgentCatalog,
    LocalAgentDefinition,
    MissingAgentDefinition,
} from "../../src/agent-catalog/local-agent.ts";
import {
    type AgentInstallation,
    AgentInstallationManager,
    FailedInstallation,
    type InstallationAudit,
    type InstallationObserver,
    RunningInstallation,
    SucceededInstallation,
} from "../../src/agent-installation/agent-installation-manager.ts";
import { FixedInstallationExecutor } from "../../src/agent-installation/fixed-installation-executor.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
class RecordingInstallationObserver implements InstallationObserver {
    readonly states: AgentInstallation[] = [];

    readonly onState = (state: AgentInstallation): Promise<void> => {
        this.states.push(state);
        return Promise.resolve();
    };
}

class RecordingInstallationAudit implements InstallationAudit {
    readonly events: string[] = [];

    readonly record = (event: string): void => {
        this.events.push(event);
    };
}

function request(requestId: string): AgentInstallRequestCommand {
    return {
        agentId: "codex",
        kind: AGENT_INSTALL_REQUEST_KIND,
        requestId,
    };
}

function createManager(
    stateDirectory: string,
    executableDirectory: string,
    catalog: LocalAgentCatalog,
    observer: RecordingInstallationObserver,
    audit: RecordingInstallationAudit,
    environment: Readonly<Record<string, string>>,
): AgentInstallationManager {
    const specification = new CodexAgentSpecification();
    return new AgentInstallationManager(
        [specification],
        new FixedInstallationExecutor(
            {
                defaultWorkspace: repositoryRoot,
                audit,
                catalog,
                environment: {
                    ...environment,
                    MOBIUS_CODEX_PATH: join(executableDirectory, "codex"),
                    MOBIUS_STATE_DIRECTORY: stateDirectory,
                    PATH: `${executableDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
                },
                publishCatalog: (signal) => {
                    signal.throwIfAborted();
                    return Promise.resolve();
                },
            },
            [specification],
        ),
        observer,
        audit,
    );
}

it("Given the daemon did not detect Codex at startup, When the user installs Codex locally and checks again, Then Mobius verifies the in-process Agent and publishes its details", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "INSTALL_REPLY");
    await using codex = await CodexFixture.create(provider);
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-integration-after-agent-install-"));
    const executableDirectory = join(stateDirectory, "external");
    const agentPath = join(executableDirectory, "codex");
    const catalog = new LocalAgentCatalog(
        [new LocalAgentDefinition("refreshed-agent", "Refreshed Agent", process.execPath, [])],
        [new MissingAgentDefinition("codex", "Codex")],
    );
    const observer = new RecordingInstallationObserver();
    const audit = new RecordingInstallationAudit();
    const manager = createManager(stateDirectory, executableDirectory, catalog, observer, audit, codex.environment);

    try {
        const missing = await manager.request(request("integration-before-agent"), AbortSignal.timeout(30_000));
        expect(missing).toBeInstanceOf(FailedInstallation);
        expect(missing).toMatchObject({
            code: "agent_not_installed",
            message: "Install Codex on this machine, then check local Agents again.",
        });
        expect(catalog.read().installableAgents[0]).toBeInstanceOf(MissingAgentDefinition);

        await mkdir(executableDirectory, { recursive: true });
        await symlink(codex.executable, agentPath);
        const installed = await manager.request(request("integration-after-agent"), AbortSignal.timeout(30_000));

        expect(installed).toBeInstanceOf(SucceededInstallation);
        // Codex hosts its ACP Agent in-process, so there is no adapter to install.
        expect(catalog.read().installableAgents).toEqual([]);
        expect(catalog.read().agents.map((agent) => agent.id)).toEqual(["refreshed-agent", "codex"]);
        expect(catalog.read().agents[1]).toMatchObject({
            agentVersion: expect.stringMatching(/\d+\.\d+\.\d+/u),
            id: "codex",
            kind: "in-process-acp",
        });
        expect(catalog.read().agents[1]?.agentIdentity.requestedPath).toBe(agentPath);
        // The app-server handshake during discovery is the whole verification: an in-process
        // Agent is ready the moment its binary is, so no install stage runs at all.
        expect(observer.states.filter((state) => state instanceof RunningInstallation)).toEqual([]);
        expect(audit.events).not.toContain("agent_adapter_verified");
    } finally {
        await rm(stateDirectory, { force: true, recursive: true });
    }
});
