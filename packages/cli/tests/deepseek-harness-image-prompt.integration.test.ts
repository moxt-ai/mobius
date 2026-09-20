import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
    DeepSeekHarnessAgentSpecification,
    discoverLocalAgentInventory,
} from "../src/agent-catalog/discover-local-agents.ts";
import type { LocalAgentDefinition } from "../src/agent-catalog/local-agent.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function executableSource(source: string): string {
    return `#!${process.execPath}\n${source}`;
}

// A DirectAcpAgentDefinition exposes one real ACP executable, so the fake ACP agent stands in for
// the DSH ACP bridge. These flags reproduce exactly the capability set a real DeepSeek Harness
// advertises when its ACP route is pointed at a model whose inputModalities include image; the
// text-only variant is the same bridge with the default text-only route.
async function writeFakeHarnessAgent(path: string, imagePrompt: boolean): Promise<void> {
    await writeFile(
        path,
        executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.1.5-rc.2\\n");
} else {
  process.argv.push(
    "--agent-name", "DeepSeek Harness",
    "--agent-version", "0.1.5-rc.2",
    "--no-load-session",
    "--http-mcp",
    "--no-additional-directories",
    "--no-delete-session",
    "--no-fork-session",
    "--no-embedded-context"${imagePrompt ? "" : ',\n    "--no-image-prompt"'},
  );
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
        { mode: 0o700 },
    );
    await chmod(path, 0o700);
}

async function discoverHarness(imagePrompt: boolean): Promise<readonly LocalAgentDefinition[]> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-dsh-image-prompt-"));
    const workspace = join(temporaryDirectory, "workspace");
    const executableDirectory = join(temporaryDirectory, "external");
    await Promise.all([mkdir(workspace), mkdir(executableDirectory)]);
    await writeFakeHarnessAgent(join(executableDirectory, "dsh"), imagePrompt);
    try {
        const inventory = await discoverLocalAgentInventory({
            defaultWorkspace: workspace,
            environment: { MOBIUS_STATE_DIRECTORY: temporaryDirectory, PATH: executableDirectory },
            signal: new AbortController().signal,
            specifications: [new DeepSeekHarnessAgentSpecification()],
        });
        expect(inventory.unavailable).toEqual([]);
        expect(inventory.readyAgents().map((agent) => agent.id)).toEqual(["deepseek-harness"]);
        return inventory.readyAgents();
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
}

describe("DeepSeek Harness image prompt capability", () => {
    it("Given a DeepSeek Harness whose ACP route accepts images, When Mobius discovers it, Then the Agent stays attachable and reports the advertised image prompt capability", async () => {
        const agents = await discoverHarness(true);

        expect(agents[0]?.capabilities.imagePrompt).toBe(true);
    });

    it("Given a DeepSeek Harness whose ACP route is text only, When Mobius discovers it, Then the Agent stays attachable without the image prompt capability", async () => {
        const agents = await discoverHarness(false);

        expect(agents[0]?.capabilities.imagePrompt).toBe(false);
    });

    it("Given an unmanaged DeepSeek Harness, When Mobius discovers it, Then the owner's Agent home is left exactly as it is", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-dsh-external-home-"));
        const workspace = join(temporaryDirectory, "workspace");
        const executableDirectory = join(temporaryDirectory, "external");
        const home = join(temporaryDirectory, "home");
        await Promise.all([mkdir(workspace), mkdir(executableDirectory), mkdir(home)]);
        await writeFakeHarnessAgent(join(executableDirectory, "dsh"), false);
        try {
            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: workspace,
                environment: {
                    DSH_HOME: home,
                    MOBIUS_STATE_DIRECTORY: temporaryDirectory,
                    PATH: executableDirectory,
                },
                signal: new AbortController().signal,
                specifications: [new DeepSeekHarnessAgentSpecification()],
            });

            expect(inventory.unavailable).toEqual([]);
            expect(inventory.readyAgents()[0]?.environment["DSH_HOME"]).toBe(home);
            await expect(readFile(join(home, "cordis.patch.yml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
