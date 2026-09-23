import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
    compareAgentVersions,
    isAgentVersionSupported,
} from "../../../../packages/cli/src/agent-catalog/agent-version.ts";
import { supportedLocalAgentSpecifications } from "../../../../packages/cli/src/agent-catalog/agents/supported-agent-specifications.ts";
import { discoverLocalAgentInventory } from "../../../../packages/cli/src/agent-catalog/discover-local-agents.ts";

function versionBefore(version: string): string {
    const core = version.split("-", 1)[0]?.split(".").map(Number);
    if (core === undefined || core.some(Number.isNaN)) {
        throw new Error(`Cannot derive a lower version from ${version}`);
    }
    for (let index = core.length - 1; index >= 0; index -= 1) {
        const part = core[index];
        if (part !== undefined && part > 0) {
            core[index] = part - 1;
            return core.join(".");
        }
    }
    throw new Error(`Cannot derive a lower version from ${version}`);
}

function versionAfter(version: string): string {
    const major = Number(version.split(".", 1)[0]);
    if (Number.isNaN(major)) {
        throw new Error(`Cannot derive a higher version from ${version}`);
    }
    return `${(major + 1).toString()}.0.0`;
}

describe("Agent discovery version policy", () => {
    it("reads versions from vendor-prefixed CLI output", () => {
        expect(isAgentVersionSupported("omp/18.2.8", "18.2.7")).toBe(true);
        expect(isAgentVersionSupported("Codex CLI v0.154.0", "0.153.0")).toBe(true);
    });

    it.each(supportedLocalAgentSpecifications())(
        "$label declares an accepted range without rejecting future versions",
        (specification) => {
            expect(
                compareAgentVersions(
                    specification.maximumTestedAgentVersion,
                    specification.minimumSupportedAgentVersion,
                ),
            ).not.toBeLessThan(0);
            expect(
                isAgentVersionSupported(
                    versionBefore(specification.minimumSupportedAgentVersion),
                    specification.minimumSupportedAgentVersion,
                ),
            ).toBe(false);
            expect(
                isAgentVersionSupported(
                    specification.maximumTestedAgentVersion,
                    specification.minimumSupportedAgentVersion,
                ),
            ).toBe(true);
            expect(
                isAgentVersionSupported(
                    versionAfter(specification.maximumTestedAgentVersion),
                    specification.minimumSupportedAgentVersion,
                ),
            ).toBe(true);
        },
    );

    it("treats an installed executable below its minimum version as not installed", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-old-agent-"));
        const specification = supportedLocalAgentSpecifications().find(({ id }) => id === "opencode");
        if (specification === undefined) {
            throw new Error("OpenCode specification is missing");
        }
        const executable = join(temporaryDirectory, specification.agentExecutable);
        try {
            await writeFile(
                executable,
                `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${versionBefore(specification.minimumSupportedAgentVersion)}\n`)});\n`,
                { mode: 0o700 },
            );
            await chmod(executable, 0o700);
            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: temporaryDirectory,
                environment: { PATH: temporaryDirectory },
                signal: new AbortController().signal,
                specifications: [specification],
            });

            expect(inventory.available).toEqual([]);
            expect(inventory.unavailable).toEqual([
                expect.objectContaining({ code: "agent_not_found", status: "missing_agent" }),
            ]);
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
