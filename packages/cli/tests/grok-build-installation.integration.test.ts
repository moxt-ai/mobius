import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentInstallationStage } from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";

import {
  AvailableAgent,
  discoverLocalAgentInventory,
  GrokBuildAgentSpecification,
} from "../src/agent-catalog/discover-local-agents.ts";
import type { InstallationAudit } from "../src/agent-installation/agent-installation-manager.ts";
import {
  type AgentInstallRecipeOptions,
  GrokBuildInstallRecipe,
} from "../src/agent-installation/fixed-agent-install-recipes.ts";
import {
  GROK_BUILD_MANAGED_VERSION,
  grokBuildManagedPackage,
} from "../src/agent-installation/grok-managed-package.ts";
import {
  type ManagedNpmPackageDefinition,
  type ManagedNpmPackageInstallationPort,
  SriManagedNpmPackageDefinition,
  validateManagedNpmPackage,
} from "../src/agent-installation/managed-npm-package.ts";

const fakeAgentPath = fileURLToPath(
  new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url),
);

function executableSource(source: string): string {
  return `#!${process.execPath}\n${source}`;
}

class RecordingAudit implements InstallationAudit {
  readonly events: string[] = [];

  readonly record = (event: string): void => {
    this.events.push(event);
  };
}

class StatefulGrokPackageInstaller
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
      throw new Error("Grok Build must use an integrity-pinned package");
    }
    const packageRoot = join(root, "node_modules", "@xai-official", "grok");
    const binDirectory = join(packageRoot, "bin");
    const wrapperPath = join(binDirectory, "grok");
    const managedHome = await realpath(join(root, "..", "home"));
    const required = definition.requiredDependencies[0];
    if (required === undefined) {
      throw new Error("Grok Build must require its platform package");
    }
    const platformRoot = join(
      root,
      "node_modules",
      ...required.packageName.split("/"),
    );
    await Promise.all([
      mkdir(binDirectory, { mode: 0o700, recursive: true }),
      mkdir(platformRoot, { mode: 0o700, recursive: true }),
    ]);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        bin: { grok: "bin/grok" },
        name: definition.packageName,
        version: definition.version,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(platformRoot, "package.json"),
      JSON.stringify({
        name: required.packageName,
        version: required.version,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          [`node_modules/${definition.packageName}`]: {
            integrity: definition.integrity,
            resolved: definition.tarballUrl,
            version: definition.version,
          },
          [`node_modules/${required.packageName}`]: {
            integrity: required.integrity,
            resolved: required.tarballUrl,
            version: required.version,
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      wrapperPath,
      executableSource('process.stdout.write("wrapper\\n");\n'),
      { mode: 0o700 },
    );
    await chmod(wrapperPath, 0o700);
    const managedAgentSource = executableSource(`
if (JSON.stringify(process.argv.slice(2)) === JSON.stringify(["version"])) {
  process.stdout.write("grok ${GROK_BUILD_MANAGED_VERSION} (managed)\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--no-auto-update", "agent", "stdio"])) process.exit(81);
  if (process.env.GROK_HOME !== ${JSON.stringify(managedHome)}) process.exit(82);
  process.argv.push("--agent-name", "Grok Build", "--agent-version", "${GROK_BUILD_MANAGED_VERSION}");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`);
    await writeFile(
      join(binDirectory, "postinstall.js"),
      `
const { chmodSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
if (process.env.GROK_HOME !== ${JSON.stringify(managedHome)}) process.exit(91);
if (process.env.HOME !== ${JSON.stringify(managedHome)}) process.exit(92);
if (process.env.GROK_INSTALL_COMPLETIONS !== "0") process.exit(93);
if (process.env.GROK_NPM_REGISTRY !== "https://registry.npmjs.org/") process.exit(94);
const destination = join(process.env.GROK_HOME, "bin", "grok");
mkdirSync(join(destination, ".."), { recursive: true });
writeFileSync(destination, ${JSON.stringify(managedAgentSource)}, { mode: 0o700 });
chmodSync(destination, 0o700);
`,
      { mode: 0o700 },
    );
    return await validateManagedNpmPackage(root, definition);
  };
}

describe("Grok Build managed installation", () => {
  it.runIf(
    (process.platform === "darwin" || process.platform === "linux") &&
      (process.arch === "arm64" || process.arch === "x64"),
  )(
    "Given the Web user confirms Grok Build installation, When its fixed recipe completes, Then the root and platform packages are pinned and ACP runs under an isolated managed GROK_HOME",
    async () => {
      const stateDirectory = await mkdtemp(
        join(tmpdir(), "mobius-grok-managed-"),
      );
      const audit = new RecordingAudit();
      const stages: AgentInstallationStage[] = [];
      const installer = new StatefulGrokPackageInstaller();
      try {
        const options: AgentInstallRecipeOptions = {
          audit,
          environment: { PATH: "" },
          report: (stage) => {
            stages.push(stage);
            return Promise.resolve();
          },
          requestId: "install-grok-build",
          signal: new AbortController().signal,
          stateDirectory,
        };
        const installed = await new GrokBuildInstallRecipe(installer).install(
          options,
        );
        expect(installed.path).toBe(
          await realpath(
            join(
              stateDirectory,
              "agents",
              "grok-build",
              GROK_BUILD_MANAGED_VERSION,
              "home",
              "bin",
              "grok",
            ),
          ),
        );
        expect(installer.definitions).toEqual([
          grokBuildManagedPackage(process.platform, process.arch),
        ]);
        expect(stages).toEqual([
          "downloading",
          "verifying",
          "installing_agent",
        ]);
        expect(audit.events).toContain("agent_npm_package_verified");
        expect(audit.events).toContain("agent_lifecycle_step_completed");

        const inventory = await discoverLocalAgentInventory({
          defaultWorkspace: stateDirectory,
          environment: { MOBIUS_STATE_DIRECTORY: stateDirectory, PATH: "" },
          signal: new AbortController().signal,
          specifications: [new GrokBuildAgentSpecification()],
        });
        expect(inventory.unavailable).toEqual([]);
        const discovered = inventory.available[0];
        if (!(discovered instanceof AvailableAgent)) {
          throw new Error("Managed Grok Build was not discovered");
        }
        expect(discovered.agent.environment).toEqual({
          GROK_HOME: await realpath(
            join(
              stateDirectory,
              "agents",
              "grok-build",
              GROK_BUILD_MANAGED_VERSION,
              "home",
            ),
          ),
        });

        const definition = grokBuildManagedPackage(
          process.platform,
          process.arch,
        );
        const required = definition.requiredDependencies[0];
        if (required === undefined) {
          throw new Error("Grok Build must require its platform package");
        }
        const integrityReplacement = required.integrity[7] === "A" ? "B" : "A";
        const tamperedIntegrity = `${required.integrity.slice(0, 7)}${integrityReplacement}${required.integrity.slice(8)}`;
        const managedPackageRoot = join(
          stateDirectory,
          "agents",
          "grok-build",
          GROK_BUILD_MANAGED_VERSION,
          "package",
        );
        await writeFile(
          join(managedPackageRoot, "package-lock.json"),
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              [`node_modules/${definition.packageName}`]: {
                integrity: definition.integrity,
                resolved: definition.tarballUrl,
                version: definition.version,
              },
              [`node_modules/${required.packageName}`]: {
                integrity: tamperedIntegrity,
                resolved: required.tarballUrl,
                version: required.version,
              },
            },
          }),
          { mode: 0o600 },
        );
        await expect(
          validateManagedNpmPackage(managedPackageRoot, definition),
        ).rejects.toMatchObject({
          code: "managed_package_verification_failed",
        });
      } finally {
        await rm(stateDirectory, { force: true, recursive: true });
      }
    },
  );
});
