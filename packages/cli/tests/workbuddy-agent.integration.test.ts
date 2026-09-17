import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { formatAgentDiagnostics } from "../src/agent-catalog/agent-diagnostics.ts";
import {
    AvailableAgent,
    discoverLocalAgentInventory,
    WorkBuddyAgentSpecification,
} from "../src/agent-catalog/discover-local-agents.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

describe("WorkBuddy Agent integration", () => {
    it("Given WorkBuddy.app is installed for the current macOS user without codebuddy on PATH, When Mobius discovers WorkBuddy, Then its embedded CLI runs through ACP", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-workbuddy-application-"));
        const executablePath = join(
            temporaryDirectory,
            "Applications",
            "WorkBuddy.app",
            "Contents",
            "Resources",
            "app.asar.unpacked",
            "cli",
            "bin",
            "codebuddy",
        );
        try {
            await mkdir(dirname(executablePath), { recursive: true });
            await writeFile(
                executablePath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("2.115.0\\n");
} else {
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--acp"])) process.exit(81);
  if (process.env.DISABLE_AUTOUPDATER !== "1") process.exit(82);
  process.argv.push("--agent-name", "WorkBuddy", "--agent-version", "2.115.0");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            );
            await chmod(executablePath, 0o700);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: {
                    HOME: temporaryDirectory,
                    MOBIUS_STATE_DIRECTORY: join(temporaryDirectory, "state"),
                    PATH: "",
                },
                platform: "darwin",
                signal: new AbortController().signal,
                specifications: [new WorkBuddyAgentSpecification()],
            });

            expect(inventory.unavailable).toEqual([]);
            expect(inventory.available).toHaveLength(1);
            const discovered = inventory.available[0];
            if (!(discovered instanceof AvailableAgent)) {
                throw new Error("WorkBuddy.app was not discovered");
            }
            expect(discovered.agent).toMatchObject({
                adapterPath: await realpath(executablePath),
                adapterVersion: "2.115.0",
                agentVersion: "2.115.0",
                arguments: ["--acp"],
                command: await realpath(executablePath),
                id: "workbuddy",
                label: "WorkBuddy",
            });
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a verified WorkBuddy runtime needs local authentication, When Mobius probes ACP, Then it reports only the local CodeBuddy sign-in entrypoint", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-workbuddy-authentication-"));
        const executablePath = join(temporaryDirectory, "codebuddy");
        try {
            await writeFile(
                executablePath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("2.146.0\\n");
} else {
  process.argv.push("--agent-name", "WorkBuddy", "--agent-version", "2.146.0", "--authentication-required");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            );
            await chmod(executablePath, 0o700);

            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: { PATH: temporaryDirectory },
                signal: new AbortController().signal,
                specifications: [new WorkBuddyAgentSpecification()],
            });

            expect(inventory.available).toEqual([]);
            expect(inventory.installable).toEqual([
                expect.objectContaining({
                    agentPath: executablePath,
                    agentVersion: "2.146.0",
                    id: "workbuddy",
                    label: "WorkBuddy",
                    status: "integration_not_installed",
                }),
            ]);
            expect(JSON.parse(formatAgentDiagnostics(inventory, true))).toEqual({
                available: [],
                unavailable: [
                    {
                        code: "authentication_required",
                        id: "workbuddy",
                        label: "WorkBuddy",
                        message: "Agent authentication is required",
                        recoveryCommand: "codebuddy",
                        status: "authentication_required",
                    },
                ],
            });
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
