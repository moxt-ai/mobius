import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_INSTALL_REQUEST_KIND,
  type AgentInstallRequestCommand,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";

import {
  DeepSeekHarnessAgentSpecification,
  type LocalAgentSpecification,
  OpenCodeAgentSpecification,
} from "../src/agent-catalog/discover-local-agents.ts";
import {
  InstallableAgentDefinition,
  LocalAgentCatalog,
} from "../src/agent-catalog/local-agent.ts";
import {
  type AgentInstallation,
  AgentInstallationManager,
  type InstallationAudit,
  type InstallationObserver,
  RunningInstallation,
  SucceededInstallation,
} from "../src/agent-installation/agent-installation-manager.ts";
import { DEEPSEEK_HARNESS_PACKAGE } from "../src/agent-installation/deepseek-managed-package.ts";
import {
  DeepSeekHarnessInstallRecipe,
  type FixedAgentInstallRecipe,
  OpenCodeInstallRecipe,
} from "../src/agent-installation/fixed-agent-install-recipes.ts";
import { FixedInstallationExecutor } from "../src/agent-installation/fixed-installation-executor.ts";
import type { AdapterInstallationPort } from "../src/agent-installation/managed-adapter-installer.ts";
import {
  type ManagedAgentArchiveDefinition,
  type ManagedAgentArchiveDownloadPort,
  type ManagedAgentArchiveInstallationPort,
  ManagedAgentArchiveInstaller,
  TarGzipManagedAgentArchiveDefinition,
  validateManagedAgentArchive,
  ZipManagedAgentArchiveDefinition,
} from "../src/agent-installation/managed-agent-archive.ts";
import {
  type ManagedNpmPackageDefinition,
  type ManagedNpmPackageInstallationPort,
  ManagedNpmPackageInstaller,
  SriManagedNpmPackageDefinition,
  validateManagedNpmPackage,
} from "../src/agent-installation/managed-npm-package.ts";
import { OPENCODE_MANAGED_VERSION } from "../src/agent-installation/opencode-managed-release.ts";
import { VerifiedDownload } from "../src/agent-installation/verified-download.ts";
import {
  resolveExecutablePath,
  runBoundedProcess,
} from "../src/process/executable.ts";

const fakeAgentPath = fileURLToPath(
  new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url),
);

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

class RejectingAdapterInstaller implements AdapterInstallationPort {
  readonly install: AdapterInstallationPort["install"] = () =>
    Promise.reject(new Error("Direct ACP Agents must not install an adapter"));
}

class StatefulDeepSeekPackageInstaller
  implements ManagedNpmPackageInstallationPort
{
  readonly definitions: ManagedNpmPackageDefinition[] = [];

  readonly install: ManagedNpmPackageInstallationPort["install"] = async (
    root,
    definition,
    _environment,
    signal,
  ) => {
    signal.throwIfAborted();
    this.definitions.push(definition);
    if (!(definition instanceof SriManagedNpmPackageDefinition)) {
      throw new Error("DeepSeek Harness must use an integrity-pinned package");
    }
    const packageRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
    const executablePath = join(packageRoot, "lib", "bin.js");
    const managedHome = await realpath(join(root, "..", "home"));
    await mkdir(join(executablePath, ".."), {
      mode: 0o700,
      recursive: true,
    });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        bin: { dsh: "lib/bin.js" },
        name: definition.packageName,
        version: definition.version,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/@deepseek-ai/dsh": {
            integrity: definition.integrity,
            resolved: definition.tarballUrl,
            version: definition.version,
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      executablePath,
      executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.1.2-rc.1\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--profile", "acp"])) process.exit(81);
  if (process.env.DSH_HOME !== ${JSON.stringify(managedHome)}) process.exit(82);
  if (process.env.DSH_PERMISSION_MODE !== "workspace-write") process.exit(83);
  process.argv.push(
    "--agent-name", "DeepSeek Harness",
    "--agent-version", "0.0.1",
    "--http-mcp",
    "--no-load-session",
    "--no-additional-directories",
    "--no-delete-session",
    "--no-embedded-context",
    "--no-fork-session",
    "--no-image-prompt"
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
      { mode: 0o700 },
    );
    await chmod(executablePath, 0o700);
    return await validateManagedNpmPackage(root, definition);
  };
}

class StatefulOpenCodeArchiveInstaller
  implements ManagedAgentArchiveInstallationPort
{
  readonly definitions: ManagedAgentArchiveDefinition[] = [];

  readonly install: ManagedAgentArchiveInstallationPort["install"] = async (
    root,
    definition,
    signal,
  ) => {
    signal.throwIfAborted();
    this.definitions.push(definition);
    const executablePath = join(root, "bin", "opencode");
    await mkdir(join(executablePath, ".."), {
      mode: 0o700,
      recursive: true,
    });
    await writeFile(
      executablePath,
      executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("1.18.29\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["acp"])) process.exit(81);
  if (process.env.OPENCODE_DISABLE_AUTOUPDATE !== "1") process.exit(82);
  process.argv.push("--agent-name", "OpenCode", "--agent-version", "1.18.29");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
      { mode: 0o700 },
    );
    await chmod(executablePath, 0o700);
    const executable = await resolveExecutablePath(executablePath);
    if (executable === null) {
      throw new Error(
        "Stateful OpenCode installer did not create an executable",
      );
    }
    return executable;
  };
}

class LocalArchiveDownloader implements ManagedAgentArchiveDownloadPort {
  readonly #archivePath: string;
  readonly #sha256: string;

  constructor(archivePath: string, sha256: string) {
    this.#archivePath = archivePath;
    this.#sha256 = sha256;
  }

  readonly download: ManagedAgentArchiveDownloadPort["download"] = async (
    options,
  ) => {
    options.signal.throwIfAborted();
    await copyFile(this.#archivePath, options.destination);
    const metadata = await stat(options.destination);
    return new VerifiedDownload(options.url, metadata.size, this.#sha256);
  };
}

function request(
  requestId: string,
  agentId: string,
): AgentInstallRequestCommand {
  return { agentId, kind: AGENT_INSTALL_REQUEST_KIND, requestId };
}

async function installThroughLocalBoundary(
  stateDirectory: string,
  specification: LocalAgentSpecification,
  recipe: FixedAgentInstallRecipe,
  observer: RecordingInstallationObserver,
  audit: RecordingInstallationAudit,
): Promise<LocalAgentCatalog> {
  const catalog = new LocalAgentCatalog(
    [],
    [new InstallableAgentDefinition(specification.id, specification.label)],
  );
  const environment = {
    MOBIUS_STATE_DIRECTORY: stateDirectory,
    PATH: "",
  };
  const manager = new AgentInstallationManager(
    [specification],
    new FixedInstallationExecutor(
      {
        audit,
        catalog,
        defaultWorkspace: stateDirectory,
        environment,
        publishCatalog: (signal) => {
          signal.throwIfAborted();
          return Promise.resolve();
        },
        stateDirectory,
      },
      [specification],
      [recipe],
      new RejectingAdapterInstaller(),
    ),
    observer,
    audit,
  );
  await expect(
    manager.request(
      request(`install-${specification.id}`, specification.id),
      new AbortController().signal,
    ),
  ).resolves.toBeInstanceOf(SucceededInstallation);
  return catalog;
}

function expectedOpenCodeChecksum(): string {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "fe764f7f360c584a83e18dd5f23fb1a6b2725f5ee8854b0252fe558f7798e946";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "9858853e7bacdbbd22c2d70c377e009dc4b354dd04f5588705411e7afb89fd2d";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "70baf769395ca4e7a68924026530c390eace194f3b7e4919d4efcb2aa2eed3c0";
  }
  return "ea800b7ff56226b70952126c9fc1e2517ca4c4b5682fd9d3f9e87449697a1194";
}

describe("direct ACP Agent installation", () => {
  it.skipIf(process.platform === "win32")(
    "Given the pinned DeepSeek Harness package needs platform binaries, When the production npm boundary installs it, Then optional dependencies are included while lifecycle scripts stay disabled",
    async () => {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "mobius-deepseek-npm-policy-"),
      );
      const executableDirectory = join(temporaryDirectory, "bin");
      const npmPath = join(executableDirectory, "npm");
      const root = join(temporaryDirectory, "managed", "0.1.2-rc.1");
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
if (!arguments_.includes("--before=2026-09-03T06:31:52.107Z")) process.exit(82);
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
  version: "0.1.2-rc.1",
}));
writeFileSync(executable, ${JSON.stringify(executableSource('process.stdout.write("managed-deepseek\\n");\n'))}, { mode: 0o700 });
chmodSync(executable, 0o700);
writeFileSync(join(prefix, "package-lock.json"), JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "node_modules/@deepseek-ai/dsh": {
      integrity: ${JSON.stringify(DEEPSEEK_HARNESS_PACKAGE.integrity)},
      resolved: ${JSON.stringify(DEEPSEEK_HARNESS_PACKAGE.tarballUrl)},
      version: "0.1.2-rc.1",
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
          await realpath(
            join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
          ),
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
        await expect(
          validateManagedNpmPackage(root, DEEPSEEK_HARNESS_PACKAGE),
        ).rejects.toMatchObject({
          code: "managed_package_verification_failed",
        });
      } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    },
  );

  it.runIf(
    (process.platform === "darwin" || process.platform === "linux") &&
      (process.arch === "arm64" || process.arch === "x64"),
  )(
    "Given the Web user confirms DeepSeek Harness installation, When its fixed recipe completes, Then the exact package starts under a separate managed DSH_HOME without an adapter",
    async () => {
      const stateDirectory = await mkdtemp(
        join(tmpdir(), "mobius-deepseek-install-"),
      );
      try {
        const packageInstaller = new StatefulDeepSeekPackageInstaller();
        const specification = new DeepSeekHarnessAgentSpecification();
        const observer = new RecordingInstallationObserver();
        const audit = new RecordingInstallationAudit();
        const catalog = await installThroughLocalBoundary(
          stateDirectory,
          specification,
          new DeepSeekHarnessInstallRecipe(packageInstaller),
          observer,
          audit,
        );

        expect(packageInstaller.definitions).toEqual([
          DEEPSEEK_HARNESS_PACKAGE,
        ]);
        expect(
          packageInstaller.definitions[0]?.includeOptionalDependencies,
        ).toBe(true);
        expect(catalog.read().agents).toHaveLength(1);
        expect(catalog.read().agents[0]).toMatchObject({
          adapterVersion: "0.1.2-rc.1",
          agentVersion: "0.1.2-rc.1",
          arguments: ["--profile", "acp"],
          environment: {
            DSH_HOME: await realpath(
              join(stateDirectory, "agents", "deepseek-harness", "home"),
            ),
            DSH_PERMISSION_MODE: "workspace-write",
          },
          id: "deepseek-harness",
        });
        expect(
          observer.states
            .filter((state) => state instanceof RunningInstallation)
            .map((state) => state.stage),
        ).toEqual([
          "downloading",
          "verifying",
          "installing_agent",
          "checking_acp",
        ]);
        expect(audit.events).toContain("agent_npm_package_verified");
        expect(audit.events).not.toContain("agent_adapter_verified");
      } finally {
        await rm(stateDirectory, { force: true, recursive: true });
      }
    },
  );

  it.runIf(
    (process.platform === "darwin" || process.platform === "linux") &&
      (process.arch === "arm64" || process.arch === "x64"),
  )(
    "Given the Web user confirms OpenCode installation, When its fixed recipe completes, Then the checksum-pinned platform archive starts directly with auto-update disabled",
    async () => {
      const stateDirectory = await mkdtemp(
        join(tmpdir(), "mobius-opencode-install-"),
      );
      try {
        const archiveInstaller = new StatefulOpenCodeArchiveInstaller();
        const specification = new OpenCodeAgentSpecification();
        const observer = new RecordingInstallationObserver();
        const audit = new RecordingInstallationAudit();
        const catalog = await installThroughLocalBoundary(
          stateDirectory,
          specification,
          new OpenCodeInstallRecipe(archiveInstaller),
          observer,
          audit,
        );

        expect(archiveInstaller.definitions).toHaveLength(1);
        expect(archiveInstaller.definitions[0]).toMatchObject({
          archiveSha256: expectedOpenCodeChecksum(),
          executableName: "opencode",
          version: OPENCODE_MANAGED_VERSION,
        });
        expect(catalog.read().agents).toHaveLength(1);
        expect(catalog.read().agents[0]).toMatchObject({
          adapterVersion: "1.18.29",
          agentVersion: "1.18.29",
          arguments: ["acp"],
          environment: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
          id: "opencode",
        });
        expect(
          observer.states
            .filter((state) => state instanceof RunningInstallation)
            .map((state) => state.stage),
        ).toEqual([
          "downloading",
          "verifying",
          "installing_agent",
          "checking_acp",
        ]);
        expect(audit.events).toContain("agent_archive_verified");
        expect(audit.events).not.toContain("agent_adapter_verified");
      } finally {
        await rm(stateDirectory, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "Given a checksum-pinned Agent archive, When the managed archive boundary installs it, Then only the expected executable is atomically published and later tampering is rejected",
    async () => {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "mobius-managed-archive-"),
      );
      try {
        const sourceDirectory = join(temporaryDirectory, "source");
        const sourceExecutable = join(sourceDirectory, "opencode");
        await mkdir(sourceDirectory, { mode: 0o700 });
        await writeFile(
          sourceExecutable,
          "#!/bin/sh\nprintf 'archive-test\\n'\n",
          { mode: 0o700 },
        );
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
            command: "/usr/bin/tar",
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

        expect(installed.path).toBe(
          await realpath(join(root, "bin", "opencode")),
        );
        await expect(
          validateManagedAgentArchive(root, definition, signal),
        ).resolves.toMatchObject({ path: installed.path });
        await writeFile(installed.path, "tampered\n", { mode: 0o700 });
        await expect(
          validateManagedAgentArchive(root, definition, signal),
        ).rejects.toMatchObject({
          code: "managed_archive_verification_failed",
        });
      } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    },
  );
});
