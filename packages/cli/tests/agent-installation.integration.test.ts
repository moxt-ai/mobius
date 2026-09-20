import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
import { DEEPSEEK_HARNESS_PACKAGE } from "../src/agent-installation/deepseek-managed-package.ts";
import { FixedInstallationExecutor } from "../src/agent-installation/fixed-installation-executor.ts";
import type { AdapterInstallationPort } from "../src/agent-installation/managed-adapter-installer.ts";
import {
    type ManagedAgentArchiveDefinition,
    type ManagedAgentArchiveDownloadPort,
    ManagedAgentArchiveInstaller,
    TarGzipManagedAgentArchiveDefinition,
    validateManagedAgentArchive,
    ZipManagedAgentArchiveDefinition,
} from "../src/agent-installation/managed-agent-archive.ts";
import {
    ManagedNpmPackageInstaller,
    validateManagedNpmPackage,
} from "../src/agent-installation/managed-npm-package.ts";
import { VerifiedDownload } from "../src/agent-installation/verified-download.ts";
import { resolveExecutablePath, runBoundedProcess } from "../src/process/executable.ts";

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

class LocalArchiveDownloader implements ManagedAgentArchiveDownloadPort {
    readonly #archivePath: string;
    readonly #sha256: string;

    constructor(archivePath: string, sha256: string) {
        this.#archivePath = archivePath;
        this.#sha256 = sha256;
    }

    readonly download: ManagedAgentArchiveDownloadPort["download"] = async (options) => {
        options.signal.throwIfAborted();
        await copyFile(this.#archivePath, options.destination);
        const metadata = await stat(options.destination);
        return new VerifiedDownload(options.url, metadata.size, this.#sha256);
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
        const catalog = new LocalAgentCatalog(
            [new LocalAgentDefinition("refreshed-agent", "Refreshed Agent", process.execPath, [])],
            [new MissingAgentDefinition("codex", "Codex")],
        );
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
            expect(catalog.read().agents.map((agent) => agent.id)).toEqual(["refreshed-agent", "codex"]);
            expect(catalog.read().agents[1]).toMatchObject({
                agentVersion: "codex 0.153.0",
                id: "codex",
            });
            expect(catalog.read().agents[1]?.agentIdentity.requestedPath).toBe(agentPath);
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
});

describe("managed Agent artifacts", () => {
    it.skipIf(process.platform === "win32")(
        "Given the pinned DeepSeek Harness package needs platform binaries, When the production npm boundary installs it, Then optional dependencies are included while lifecycle scripts stay disabled",
        async () => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-deepseek-npm-policy-"));
            const executableDirectory = join(temporaryDirectory, "bin");
            const npmPath = join(executableDirectory, "npm");
            const root = join(temporaryDirectory, "managed", DEEPSEEK_HARNESS_PACKAGE.version);
            try {
                await mkdir(executableDirectory, { mode: 0o700, recursive: true });
                await writeFile(
                    npmPath,
                    executableSource(`
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const arguments_ = process.argv.slice(2);
const prefixIndex = arguments_.indexOf("--prefix");
const prefix = arguments_[prefixIndex + 1];
if (prefixIndex < 0 || prefix === undefined) process.exit(81);
if (!arguments_.includes("--before=2026-09-18T00:00:00.000Z")) process.exit(82);
if (!arguments_.includes("--include=optional")) process.exit(83);
if (arguments_.includes("--omit=optional")) process.exit(84);
if (!arguments_.includes("--ignore-scripts")) process.exit(85);
if (process.env.NPM_CONFIG_INCLUDE !== "optional") process.exit(86);
if (process.env.NPM_CONFIG_OMIT !== undefined) process.exit(87);
if (process.env.NPM_CONFIG_IGNORE_SCRIPTS !== "true") process.exit(88);
const packageRoot = join(prefix, "node_modules", "@deepseek-ai", "dsh");
const executable = join(packageRoot, "lib", "bin.js");
mkdirSync(join(executable, ".."), { recursive: true });
writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
  bin: { dsh: "lib/bin.js" },
  name: "@deepseek-ai/dsh",
  version: "0.1.5-rc.2",
}));
writeFileSync(executable, ${JSON.stringify(executableSource('process.stdout.write("managed-deepseek\\n");\n'))}, { mode: 0o700 });
chmodSync(executable, 0o700);
writeFileSync(join(prefix, "package-lock.json"), JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "node_modules/@deepseek-ai/dsh": {
      integrity: ${JSON.stringify(DEEPSEEK_HARNESS_PACKAGE.integrity)},
      resolved: ${JSON.stringify(DEEPSEEK_HARNESS_PACKAGE.tarballUrl)},
      version: "0.1.5-rc.2",
    },
  },
}));
`),
                    { mode: 0o700 },
                );
                await chmod(npmPath, 0o700);

                const installed = await new ManagedNpmPackageInstaller().install(
                    root,
                    DEEPSEEK_HARNESS_PACKAGE,
                    { PATH: executableDirectory },
                    new AbortController().signal,
                );

                expect(installed.path).toBe(
                    await realpath(join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")),
                );
                await writeFile(
                    join(root, "package-lock.json"),
                    JSON.stringify({
                        lockfileVersion: 3,
                        packages: {
                            "node_modules/@deepseek-ai/dsh": {
                                integrity: DEEPSEEK_HARNESS_PACKAGE.integrity,
                                resolved: DEEPSEEK_HARNESS_PACKAGE.tarballUrl,
                                version: DEEPSEEK_HARNESS_PACKAGE.version,
                            },
                            "node_modules/unlocked-dependency": {
                                resolved:
                                    "https://registry.npmjs.org/unlocked-dependency/-/unlocked-dependency-1.0.0.tgz",
                                version: "1.0.0",
                            },
                        },
                    }),
                    { mode: 0o600 },
                );
                await expect(validateManagedNpmPackage(root, DEEPSEEK_HARNESS_PACKAGE)).rejects.toMatchObject({
                    code: "managed_package_verification_failed",
                });
            } finally {
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );

    it.runIf(process.platform === "darwin" || process.platform === "linux")(
        "Given a checksum-pinned Agent archive, When the managed archive boundary installs it, Then only the expected executable is atomically published and later tampering is rejected",
        async () => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-managed-archive-"));
            try {
                const sourceDirectory = join(temporaryDirectory, "source");
                const sourceExecutable = join(sourceDirectory, "opencode");
                await mkdir(sourceDirectory, { mode: 0o700 });
                await writeFile(sourceExecutable, "#!/bin/sh\nprintf 'archive-test\\n'\n", { mode: 0o700 });
                await chmod(sourceExecutable, 0o700);
                const archivePath = join(
                    temporaryDirectory,
                    process.platform === "darwin" ? "opencode.zip" : "opencode.tar.gz",
                );
                if (process.platform === "darwin") {
                    await runBoundedProcess({
                        arguments: ["-q", archivePath, "opencode"],
                        command: "/usr/bin/zip",
                        cwd: sourceDirectory,
                        environment: { PATH: "/usr/bin:/bin" },
                        signal: new AbortController().signal,
                        timeoutMilliseconds: 10_000,
                    });
                } else {
                    await runBoundedProcess({
                        arguments: ["-czf", archivePath, "-C", sourceDirectory, "opencode"],
                        command: "/bin/tar",
                        cwd: temporaryDirectory,
                        environment: { PATH: "/usr/bin:/bin" },
                        signal: new AbortController().signal,
                        timeoutMilliseconds: 10_000,
                    });
                }
                const archiveBytes = await readFile(archivePath);
                const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
                let definition: ManagedAgentArchiveDefinition;
                if (process.platform === "darwin") {
                    definition = new ZipManagedAgentArchiveDefinition(
                        "test-version",
                        "opencode.zip",
                        new URL("https://github.com/example/opencode.zip"),
                        sha256,
                        "opencode",
                    );
                } else {
                    definition = new TarGzipManagedAgentArchiveDefinition(
                        "test-version",
                        "opencode.tar.gz",
                        new URL("https://github.com/example/opencode.tar.gz"),
                        sha256,
                        "opencode",
                    );
                }
                const root = join(temporaryDirectory, "managed", "test-version");
                const signal = new AbortController().signal;
                const installed = await new ManagedAgentArchiveInstaller(
                    new LocalArchiveDownloader(archivePath, sha256),
                ).install(root, definition, signal);

                expect(installed.path).toBe(await realpath(join(root, "bin", "opencode")));
                await expect(validateManagedAgentArchive(root, definition, signal)).resolves.toMatchObject({
                    path: installed.path,
                });
                await writeFile(installed.path, "tampered\n", { mode: 0o700 });
                await expect(validateManagedAgentArchive(root, definition, signal)).rejects.toMatchObject({
                    code: "managed_archive_verification_failed",
                });
            } finally {
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );
});
