import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
    AvailableAgent,
    DeepSeekHarnessAgentSpecification,
    discoverLocalAgentInventory,
    OpenCodeAgentSpecification,
} from "../src/agent-catalog/discover-local-agents.ts";
import {
    OPENCODE_MANAGED_VERSION,
    openCodeManagedArchive,
} from "../src/agent-installation/opencode-managed-release.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

describe("direct ACP Agent discovery", () => {
    it("Given an untrusted relative DSH_HOME, When DeepSeek Harness discovery runs, Then Mobius refuses to launch the ACP profile", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-deepseek-home-"));
        const dshPath = join(temporaryDirectory, "dsh");
        try {
            await writeFile(
                dshPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.1.5-rc.2\\n");
} else {
  process.exit(80);
}
`),
                { mode: 0o700 },
            );
            await chmod(dshPath, 0o700);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: { DSH_HOME: "relative-home", PATH: temporaryDirectory },
                signal: new AbortController().signal,
                specifications: [new DeepSeekHarnessAgentSpecification()],
            });

            expect(inventory.available).toEqual([]);
            expect(inventory.unavailable).toHaveLength(1);
            expect(inventory.unavailable[0]).toMatchObject({
                code: "agent_environment_invalid",
                status: "probe_failed",
            });
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it.runIf(
        (process.platform === "darwin" || process.platform === "linux") &&
            (process.arch === "arm64" || process.arch === "x64"),
    )(
        "Given an incompatible PATH OpenCode and a verified managed OpenCode, When discovery falls back, Then one managed executable owns both direct ACP identities",
        async () => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-opencode-fallback-"));
            const externalDirectory = join(temporaryDirectory, "external");
            const stateDirectory = join(temporaryDirectory, "state");
            const externalPath = join(externalDirectory, "opencode");
            const managedRoot = join(stateDirectory, "agents", "opencode", OPENCODE_MANAGED_VERSION);
            const managedPath = join(managedRoot, "bin", "opencode");
            try {
                await mkdir(externalDirectory, { mode: 0o700 });
                await mkdir(join(managedRoot, "bin"), { mode: 0o700, recursive: true });
                await writeFile(
                    externalPath,
                    executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("1.18.29\\n");
} else {
  process.argv.push("--agent-name", "OpenCode", "--agent-version", "1.18.29", "--no-load-session");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                    { mode: 0o700 },
                );
                const managedSource = executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("1.18.29\\n");
} else {
  process.argv.push("--agent-name", "OpenCode", "--agent-version", "1.18.29");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`);
                await writeFile(managedPath, managedSource, { mode: 0o700 });
                await Promise.all([chmod(externalPath, 0o700), chmod(managedPath, 0o700)]);
                const definition = openCodeManagedArchive(process.platform, process.arch);
                await writeFile(
                    join(managedRoot, "archive.json"),
                    `${JSON.stringify({
                        archiveSha256: definition.archiveSha256,
                        archiveUrl: definition.archiveUrl.toString(),
                        executableSha256: createHash("sha256").update(managedSource).digest("hex"),
                        version: definition.version,
                    })}\n`,
                    { mode: 0o600 },
                );

                const inventory = await discoverLocalAgentInventory({
                    defaultWorkspace: temporaryDirectory,
                    environment: {
                        MOBIUS_STATE_DIRECTORY: stateDirectory,
                        PATH: externalDirectory,
                    },
                    signal: new AbortController().signal,
                    specifications: [new OpenCodeAgentSpecification()],
                });

                expect(inventory.unavailable).toEqual([]);
                expect(inventory.available).toHaveLength(1);
                const discovered = inventory.available[0];
                if (!(discovered instanceof AvailableAgent)) {
                    throw new Error("Managed OpenCode was not discovered");
                }
                const canonicalManagedPath = await realpath(managedPath);
                expect(discovered.agent.command).toBe(canonicalManagedPath);
                expect(discovered.agent.adapterIdentity.realPath).toBe(canonicalManagedPath);
                expect(discovered.agent.agentIdentity.realPath).toBe(canonicalManagedPath);
            } finally {
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );
});
