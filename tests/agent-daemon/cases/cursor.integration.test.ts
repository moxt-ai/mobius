import { readFile } from "node:fs/promises";
import { it } from "vitest";
import { discoverLocalAgentInventory } from "../../../packages/cli/src/agent-catalog/discover-local-agents.ts";
import { CursorFixture } from "../infra/cursor.ts";
import {
    allowOneTimeToolPermission,
    expectPersistedToolTurn,
    runAgentDaemonTurn,
    startAgentDaemonJourney,
} from "../infra/journey.ts";
import { FakeCursorProvider } from "../providers/cursor.ts";

it("Given real Cursor CLI uses a local Cursor protocol provider, When a prompt causes a tool call across the server and daemon protocols, Then the ACP tool and response are persisted", {
    timeout: 120_000,
}, async () => {
    const signal = AbortSignal.timeout(110_000);
    await using cursorProvider = await FakeCursorProvider.start();
    await using cursor = await CursorFixture.create(cursorProvider);
    await using journey = await startAgentDaemonJourney({
        agentEnvironment: cursor.environment,
        agentId: "cursor",
        agentPath: cursor.executable,
        onDiscoveryFailure: async () => {
            const diagnostics = await discoverLocalAgentInventory({
                defaultWorkspace: process.cwd(),
                environment: { ...process.env, ...cursor.environment },
                signal,
            });
            process.stderr.write(
                `Cursor CLI discovery diagnostics:\n${JSON.stringify(
                    diagnostics.unavailable.map(({ code, message, specification, status }) => ({
                        code,
                        id: specification.id,
                        message,
                        status,
                    })),
                    null,
                    2,
                )}\n`,
            );
        },
        prompt: "Use a shell tool, then reply using the configured model",
        sessionId: "real-cursor-local-provider",
        signal,
        title: "Real Cursor local provider",
    });

    try {
        await runAgentDaemonTurn(journey, {
            afterSubmit: () => allowOneTimeToolPermission(journey),
        });
        await expectPersistedToolTurn(journey, FakeCursorProvider.response);
    } catch (error) {
        process.stderr.write(
            `Cursor CLI integration diagnostics:\n${JSON.stringify(
                {
                    daemonOutput: journey.daemon.output,
                    cursorStderr: await readFile(cursor.stderrPath, "utf8").catch(() => ""),
                    messages: await journey.messages(),
                    trace: { path: cursorProvider.tracePath, messages: cursorProvider.rawMessages().slice(-20) },
                },
                null,
                2,
            )}\n`,
        );
        throw error;
    }
});
