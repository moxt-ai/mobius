import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { discoverLocalAgentInventory } from "../../src/engine/agent/discovery/discover-local-agents.ts";
import { PiAgentSpecification } from "../../src/engine/agent/specification/vendors/pi-agent.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";

function sessionHeader(sessionId: string, cwd: string): string {
    return `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`;
}

test("Given Pi's default workspace creates an oversized native session path, When Mobius discovers Pi, Then Pi remains available and stores its session under Mobius state", async () => {
    await using provider = await FakeOpenAiProvider.start("mobius-test-model", "SESSION_PROBE_COMPLETED");
    await using agent = await PiFixture.create(provider);
    const fixtureHome = agent.environment["HOME"];
    if (fixtureHome === undefined) {
        throw new Error("The Pi fixture must set HOME");
    }
    const stateDirectory = join(fixtureHome, "mobius-state");
    const workspace = join(tmpdir(), "w".repeat(130), "w".repeat(130));
    await mkdir(workspace, { recursive: true });
    try {
        const inventory = await discoverLocalAgentInventory({
            dataDirectory: stateDirectory,
            defaultWorkspace: workspace,
            environment: {
                ...agent.environment,
                MOBIUS_STATE_DIRECTORY: stateDirectory,
                // Keep the real CLI discoverable; PiFixture only removes unrelated Agent launchers.
                PATH: process.env["PATH"] ?? "",
            },
            signal: AbortSignal.timeout(30_000),
            specifications: [new PiAgentSpecification()],
        });

        expect(inventory.unavailable).toEqual([]);
        expect(inventory.available).toHaveLength(1);
        expect(inventory.available[0]).toMatchObject({ specification: { id: "pi", label: "Pi" }, status: "ready" });
        const workspaceHash = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
        const mobiusSessionsRoot = join(stateDirectory, "agents", "pi", "sessions");
        const sessionsRoot = join(mobiusSessionsRoot, workspaceHash);
        expect((await readdir(sessionsRoot)).every((entry) => entry.length <= 128)).toBe(true);

        const legacyDirectory = join(fixtureHome, ".pi", "agent", "sessions", "terminal-project");
        await mkdir(legacyDirectory, { recursive: true });
        await writeFile(
            join(legacyDirectory, "terminal-session.jsonl"),
            sessionHeader("terminal-pi-session", workspace),
        );
        const { listPiSessions } = await import("../../src/engine/acp/harness/pi/upstream/acp/pi-sessions.ts");
        const discoveryEnvironment = { ...agent.environment, MOBIUS_PI_SESSION_DIR: sessionsRoot };
        expect(listPiSessions(discoveryEnvironment)).toContainEqual(
            expect.objectContaining({ sessionId: "terminal-pi-session", cwd: workspace }),
        );

        const otherWorkspaceHash = createHash("sha256").update(`${workspace}-other`).digest("hex").slice(0, 24);
        const otherSessionsDirectory = join(mobiusSessionsRoot, otherWorkspaceHash);
        await mkdir(otherSessionsDirectory, { recursive: true });
        await writeFile(
            join(otherSessionsDirectory, "other-connection-session.jsonl"),
            sessionHeader("other-connection-pi-session", workspace),
        );
        expect(listPiSessions(discoveryEnvironment)).toContainEqual(
            expect.objectContaining({ sessionId: "other-connection-pi-session", cwd: workspace }),
        );
    } finally {
        await rm(workspace, { force: true, recursive: true });
    }
});
