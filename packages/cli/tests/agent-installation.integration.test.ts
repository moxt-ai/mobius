import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_INSTALL_REQUEST_KIND, type AgentInstallRequestCommand } from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";

import { CodexAgentSpecification } from "../src/agent-catalog/discover-local-agents.ts";
import {
    AgentIntegrationDefinition,
    LocalAgentCatalog,
    LocalAgentDefinition,
    MissingAgentDefinition,
} from "../src/agent-catalog/local-agent.ts";
import {
    type AgentInstallation,
    AgentInstallationManager,
    FailedInstallation,
    type InstallationAudit,
    type InstallationObserver,
    RunningInstallation,
    SucceededInstallation,
} from "../src/agent-installation/agent-installation-manager.ts";
import { FixedInstallationExecutor } from "../src/agent-installation/fixed-installation-executor.ts";
import type { AdapterInstallationPort } from "../src/agent-installation/managed-adapter-installer.ts";
import { resolveExecutablePath } from "../src/process/executable.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

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

// The real adapter registry is mutable and requires network access. This
// stateful boundary publishes a disposable adapter while production discovery,
// executable validation, ACP probing, and catalog transitions remain real.
class StatefulAdapterInstaller implements AdapterInstallationPort {
    readonly #stateDirectory: string;
    readonly installedAgentIds: string[] = [];

    constructor(stateDirectory: string) {
        this.#stateDirectory = stateDirectory;
    }

    readonly install: AdapterInstallationPort["install"] = async (specification, signal) => {
        signal.throwIfAborted();
        this.installedAgentIds.push(specification.id);
        const directory = join(
            this.#stateDirectory,
            "adapters",
            specification.id,
            specification.adapterVersion,
            "node_modules",
            "@agentclientprotocol",
            "codex-acp",
            "dist",
        );
        const path = join(directory, "index.js");
        await mkdir(directory, { mode: 0o700, recursive: true });
        await writeFile(
            path,
            executableSource(`
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.8.0\\n");
} else {
  const executable = process.env[${JSON.stringify(specification.adapterEnvironmentVariable)}];
  if (executable === undefined) process.exit(91);
  const child = spawn(executable, [], { env: process.env, stdio: "inherit" });
  child.once("error", () => process.exit(92));
  child.once("exit", (code) => process.exit(code ?? 93));
}
`),
            { mode: 0o700 },
        );
        await chmod(path, 0o700);
        const executable = await resolveExecutablePath(path);
        if (executable === null) {
            throw new Error("Stateful adapter installer did not create an executable");
        }
        return executable;
    };
}

async function writeExternalCodexAgent(path: string): Promise<void> {
    await mkdir(join(path, ".."), { mode: 0o700, recursive: true });
    await writeFile(
        path,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex 0.153.0\\n");
} else {
  process.argv.push("--agent-name", "Codex");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
    );
    await chmod(path, 0o700);
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
    adapterInstaller: AdapterInstallationPort,
    observer: RecordingInstallationObserver,
    audit: RecordingInstallationAudit,
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
                    MOBIUS_STATE_DIRECTORY: stateDirectory,
                    PATH: executableDirectory,
                },
                publishCatalog: (signal) => {
                    signal.throwIfAborted();
                    return Promise.resolve();
                },
                stateDirectory,
            },
            [specification],
            adapterInstaller,
        ),
        observer,
        audit,
    );
}

describe("local Agent integration installation", () => {
    it("Given the daemon did not detect Codex at startup, When the user installs Codex locally and checks again, Then Mobius installs only the adapter and publishes the detected Agent details", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-integration-after-agent-install-"));
        const executableDirectory = join(stateDirectory, "external");
        const agentPath = join(executableDirectory, "codex");
        const catalog = new LocalAgentCatalog([], [new MissingAgentDefinition("codex", "Codex")]);
        const adapterInstaller = new StatefulAdapterInstaller(stateDirectory);
        const observer = new RecordingInstallationObserver();
        const audit = new RecordingInstallationAudit();
        const manager = createManager(stateDirectory, executableDirectory, catalog, adapterInstaller, observer, audit);

        try {
            const missing = await manager.request(request("integration-before-agent"), new AbortController().signal);
            expect(missing).toBeInstanceOf(FailedInstallation);
            expect(missing).toMatchObject({
                code: "agent_not_installed",
                message: "Install Codex on this machine, then check local Agents again.",
            });
            expect(adapterInstaller.installedAgentIds).toEqual([]);
            expect(catalog.read().installableAgents[0]).toBeInstanceOf(MissingAgentDefinition);

            await writeExternalCodexAgent(agentPath);
            const installed = await manager.request(request("integration-after-agent"), new AbortController().signal);

            expect(installed).toBeInstanceOf(SucceededInstallation);
            expect(adapterInstaller.installedAgentIds).toEqual(["codex"]);
            expect(catalog.read().installableAgents).toEqual([]);
            expect(catalog.read().agents).toHaveLength(1);
            expect(catalog.read().agents[0]).toMatchObject({
                agentVersion: "codex 0.153.0",
                id: "codex",
            });
            expect(catalog.read().agents[0]?.agentIdentity.requestedPath).toBe(agentPath);
            expect(
                observer.states
                    .filter(
                        (state): state is RunningInstallation =>
                            state instanceof RunningInstallation && state.requestId === "integration-after-agent",
                    )
                    .map((state) => state.stage),
            ).toEqual(["installing_adapter", "checking_acp"]);
            expect(audit.events).toContain("agent_installation_acp_verified");
        } finally {
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given Codex is installed with an incompatible automatically discovered adapter, When the user installs the integration, Then Mobius preserves Codex and replaces only the adapter", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-integration-adapter-repair-"));
        const executableDirectory = join(stateDirectory, "external");
        const agentPath = join(executableDirectory, "codex");
        const adapterPath = join(executableDirectory, "codex-acp");
        const catalog = new LocalAgentCatalog(
            [],
            [new AgentIntegrationDefinition("codex", "Codex", agentPath, "codex 0.153.0")],
        );
        const adapterInstaller = new StatefulAdapterInstaller(stateDirectory);
        const observer = new RecordingInstallationObserver();
        const audit = new RecordingInstallationAudit();

        try {
            await writeExternalCodexAgent(agentPath);
            await writeFile(
                adapterPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("codex-acp 1.7.0\\n");
} else {
  process.exit(7);
}
`),
                { mode: 0o700 },
            );
            await chmod(adapterPath, 0o700);
            const manager = createManager(
                stateDirectory,
                executableDirectory,
                catalog,
                adapterInstaller,
                observer,
                audit,
            );

            await expect(
                manager.request(request("repair-integration"), new AbortController().signal),
            ).resolves.toBeInstanceOf(SucceededInstallation);

            expect(adapterInstaller.installedAgentIds).toEqual(["codex"]);
            expect(catalog.read().agents[0]?.agentIdentity.requestedPath).toBe(agentPath);
            expect(catalog.read().agents[0]?.adapterIdentity.requestedPath).not.toBe(await realpath(adapterPath));
            expect(
                observer.states.filter((state) => state instanceof RunningInstallation).map((state) => state.stage),
            ).toEqual(["checking_acp", "installing_adapter", "checking_acp"]);
        } finally {
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });

    it("Given a refreshed catalog contains other ready Agents, When automatic integration setup verifies Codex, Then it preserves the unrelated refreshed catalog entries", async () => {
        const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-integration-catalog-merge-"));
        const executableDirectory = join(stateDirectory, "external");
        const agentPath = join(executableDirectory, "codex");
        const adapterInstaller = new StatefulAdapterInstaller(stateDirectory);
        const observer = new RecordingInstallationObserver();
        const audit = new RecordingInstallationAudit();

        try {
            await writeExternalCodexAgent(agentPath);
            const catalog = new LocalAgentCatalog(
                [new LocalAgentDefinition("refreshed-agent", "Refreshed Agent", agentPath, [])],
                [new AgentIntegrationDefinition("codex", "Codex", agentPath, "codex 0.153.0")],
            );
            const manager = createManager(
                stateDirectory,
                executableDirectory,
                catalog,
                adapterInstaller,
                observer,
                audit,
            );

            await expect(
                manager.request(request("automatic-integration-catalog-merge"), new AbortController().signal),
            ).resolves.toBeInstanceOf(SucceededInstallation);

            expect(catalog.read().agents.map((agent) => agent.id)).toEqual(["refreshed-agent", "codex"]);
            expect(catalog.read().installableAgents).toEqual([]);
        } finally {
            await rm(stateDirectory, { force: true, recursive: true });
        }
    });
});
