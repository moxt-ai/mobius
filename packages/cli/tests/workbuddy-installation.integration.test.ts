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
  WorkBuddyAgentSpecification,
} from "../src/agent-catalog/discover-local-agents.ts";
import type { InstallationAudit } from "../src/agent-installation/agent-installation-manager.ts";
import {
  type AgentInstallRecipeOptions,
  WorkBuddyInstallRecipe,
} from "../src/agent-installation/fixed-agent-install-recipes.ts";
import {
  type ManagedNpmPackageDefinition,
  type ManagedNpmPackageInstallationPort,
  SriManagedNpmPackageDefinition,
  validateManagedNpmPackage,
} from "../src/agent-installation/managed-npm-package.ts";
import {
  WORKBUDDY_MANAGED_PACKAGE,
  WORKBUDDY_MANAGED_VERSION,
} from "../src/agent-installation/workbuddy-managed-package.ts";

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

class StatefulWorkBuddyPackageInstaller
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
      throw new Error("WorkBuddy must use an integrity-pinned package");
    }
    const packageRoot = join(
      root,
      "node_modules",
      "@tencent-ai",
      "codebuddy-code",
    );
    const executablePath = join(packageRoot, "bin", "codebuddy");
    await mkdir(join(executablePath, ".."), {
      mode: 0o700,
      recursive: true,
    });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        bin: { codebuddy: "bin/codebuddy" },
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
          "node_modules/@tencent-ai/codebuddy-code": {
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
  process.stdout.write("${WORKBUDDY_MANAGED_VERSION}\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--acp"])) process.exit(81);
  if (process.env.DISABLE_AUTOUPDATER !== "1") process.exit(82);
  process.argv.push("--agent-name", "WorkBuddy", "--agent-version", "${WORKBUDDY_MANAGED_VERSION}");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
      { mode: 0o700 },
    );
    await chmod(executablePath, 0o700);
    return await validateManagedNpmPackage(root, definition);
  };
}

describe("WorkBuddy managed installation", () => {
  it.runIf(
    (process.platform === "darwin" || process.platform === "linux") &&
      (process.arch === "arm64" || process.arch === "x64"),
  )(
    "Given the Web user confirms WorkBuddy installation, When its fixed recipe completes, Then the integrity-pinned CodeBuddy Code package is published only after ACP verification",
    async () => {
      const stateDirectory = await mkdtemp(
        join(tmpdir(), "mobius-workbuddy-managed-"),
      );
      const audit = new RecordingAudit();
      const stages: AgentInstallationStage[] = [];
      const installer = new StatefulWorkBuddyPackageInstaller();
      try {
        const options: AgentInstallRecipeOptions = {
          audit,
          environment: { PATH: "" },
          report: (stage) => {
            stages.push(stage);
            return Promise.resolve();
          },
          requestId: "install-workbuddy",
          signal: new AbortController().signal,
          stateDirectory,
        };
        const installed = await new WorkBuddyInstallRecipe(installer).install(
          options,
        );
        expect(installed.path).toBe(
          await realpath(
            join(
              stateDirectory,
              "agents",
              "workbuddy",
              WORKBUDDY_MANAGED_VERSION,
              "node_modules",
              "@tencent-ai",
              "codebuddy-code",
              "bin",
              "codebuddy",
            ),
          ),
        );
        expect(installer.definitions).toEqual([WORKBUDDY_MANAGED_PACKAGE]);
        expect(stages).toEqual([
          "downloading",
          "verifying",
          "installing_agent",
        ]);
        expect(audit.events).toContain("agent_npm_package_verified");

        const inventory = await discoverLocalAgentInventory({
          defaultWorkspace: stateDirectory,
          environment: { MOBIUS_STATE_DIRECTORY: stateDirectory, PATH: "" },
          signal: new AbortController().signal,
          specifications: [new WorkBuddyAgentSpecification()],
        });
        expect(inventory.unavailable).toEqual([]);
        const discovered = inventory.available[0];
        if (!(discovered instanceof AvailableAgent)) {
          throw new Error("Managed WorkBuddy was not discovered");
        }
        expect(discovered.agent.environment).toEqual({
          DISABLE_AUTOUPDATER: "1",
        });
      } finally {
        await rm(stateDirectory, { force: true, recursive: true });
      }
    },
  );
});
