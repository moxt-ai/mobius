import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { AvailableAgent } from "../../../packages/cli/src/agent-catalog/agent-discovery.ts";
import { OhMyPiAgentSpecification } from "../../../packages/cli/src/agent-catalog/agents/oh-my-pi-agent.ts";
import { discoverLocalAgentInventory } from "../../../packages/cli/src/agent-catalog/discover-local-agents.ts";
import { resolveTestExecutable } from "../infra/executable.ts";

it("discovers the real installed Oh My Pi version through its ACP readiness probe", { timeout: 60_000 }, async () => {
    const specification = new OhMyPiAgentSpecification();
    const executable = await resolveTestExecutable("omp", "MOBIUS_TEST_OH_MY_PI_PATH");
    const home = await mkdtemp(join(tmpdir(), "mobius-real-oh-my-pi-"));
    try {
        const inventory = await discoverLocalAgentInventory({
            defaultWorkspace: home,
            environment: {
                ...Object.fromEntries(
                    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
                ),
                HOME: home,
                MOBIUS_OH_MY_PI_PATH: executable,
            },
            signal: AbortSignal.timeout(50_000),
            specifications: [specification],
        });

        expect(inventory.unavailable).toEqual([]);
        expect(inventory.available).toHaveLength(1);
        const discovered = inventory.available[0];
        expect(discovered).toBeInstanceOf(AvailableAgent);
        expect(discovered?.agent).toMatchObject({
            agentVersion: expect.stringContaining(specification.maximumTestedAgentVersion),
            id: specification.id,
        });
    } finally {
        await rm(home, { force: true, recursive: true });
    }
});
