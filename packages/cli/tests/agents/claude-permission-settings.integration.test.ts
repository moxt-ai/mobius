import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeSessionReadyEvent, encodeSessionPrepareCommand } from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { ClaudeCodeAgentSpecification } from "../../src/agent-catalog/agents/claude-code-agent.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { withRealDaemon } from "../support/agents/real-daemon.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";

test.each([true, false])(
    "Given bypass is configured in a %s user settings file, When Claude starts through the daemon, Then only the trusted user mode is inherited",
    async (trusted) => {
        await using provider = await FakeAnthropicProvider.start("claude-sonnet-4-6", "PERMISSION_SETTINGS_OK");
        await using agent = await ClaudeFixture.create(provider);
        const home = agent.environment["HOME"];
        if (home === undefined) {
            throw new Error("Missing fixture home");
        }
        const workspace = trusted ? home : join(home, "project");
        const config = join(home, ".claude");
        await mkdir(config, { recursive: true });
        await mkdir(join(workspace, ".claude"), { recursive: true });
        await writeFile(
            join(trusted ? config : join(workspace, ".claude"), "settings.json"),
            JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
        );
        const environment = { ...agent.environment, CLAUDE_CONFIG_DIR: config };
        await withRealDaemon(
            new ClaudeCodeAgentSpecification(),
            environment,
            async (peer) => {
                const requestId = randomUUID();
                peer.send(
                    encodeSessionPrepareCommand({
                        kind: "session.prepare",
                        requestId,
                        sessionId: peer.sessionId,
                        agentId: "claude",
                        bindingId: peer.bindingId,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                    }),
                );
                for (;;) {
                    const message = JSON.parse(await peer.nextMessage());
                    if (message.kind === "session.operation.failed") {
                        throw new Error(JSON.stringify(message));
                    }
                    if (message.kind !== "session.ready") {
                        continue;
                    }
                    const ready = decodeSessionReadyEvent(JSON.stringify(message));
                    if (ready.requestId !== requestId) {
                        continue;
                    }
                    const option = ready.configOptions.find((option) => option.id === "mode");
                    expect(option?.type === "select" ? option.currentValue : undefined).toBe(
                        trusted ? "bypassPermissions" : "default",
                    );
                    break;
                }
            },
            "managed",
            workspace,
        );
    },
);
