import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AcpSessionManager } from "../src/acp/session-manager.ts";
import { LocalAgentDefinition } from "../src/config.ts";

const fakeAgentPath = fileURLToPath(
  new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url),
);

describe("ACP conversation sessions", () => {
  it("keeps one ACP session alive across conversation turns", async () => {
    const manager = new AcpSessionManager();
    const agent = new LocalAgentDefinition("codex", "Codex", process.execPath, [
      fakeAgentPath,
      "--agent-name",
      "Codex",
    ]);
    const firstChunks: string[] = [];
    const secondChunks: string[] = [];

    try {
      await manager.runPrompt({
        agent,
        cwd: process.cwd(),
        onActivity: () => Promise.resolve(),
        onText: (text) => {
          firstChunks.push(text);
          return Promise.resolve();
        },
        prompt: "first",
        sessionId: "browser-conversation",
        signal: new AbortController().signal,
      });
      await manager.runPrompt({
        agent,
        cwd: process.cwd(),
        onActivity: () => Promise.resolve(),
        onText: (text) => {
          secondChunks.push(text);
          return Promise.resolve();
        },
        prompt: "second",
        sessionId: "browser-conversation",
        signal: new AbortController().signal,
      });
    } finally {
      await manager.close();
    }

    expect(firstChunks.join("")).toBe("Codex turn 1: first");
    expect(secondChunks.join("")).toBe("Codex turn 2: second");
  });

  it("Given a turn is running, When it is cancelled, Then ACP stops that turn and keeps the session usable", async () => {
    const manager = new AcpSessionManager();
    const agent = new LocalAgentDefinition("codex", "Codex", process.execPath, [
      fakeAgentPath,
      "--agent-name",
      "Codex",
    ]);
    const activityStarted = Promise.withResolvers<void>();

    try {
      const cancelledTurn = manager.runPrompt({
        agent,
        cwd: process.cwd(),
        onActivity: () => {
          activityStarted.resolve();
          return Promise.resolve();
        },
        onText: () => Promise.resolve(),
        prompt: "wait until cancelled",
        sessionId: "cancelled-conversation",
        signal: new AbortController().signal,
      });
      await activityStarted.promise;

      await manager.cancelPrompt("cancelled-conversation");

      await expect(cancelledTurn).resolves.toEqual({
        stopReason: "cancelled",
      });
      const nextChunks: string[] = [];
      await manager.runPrompt({
        agent,
        cwd: process.cwd(),
        onActivity: () => Promise.resolve(),
        onText: (text) => {
          nextChunks.push(text);
          return Promise.resolve();
        },
        prompt: "continue",
        sessionId: "cancelled-conversation",
        signal: new AbortController().signal,
      });
      expect(nextChunks.join("")).toBe("Codex turn 2: continue");
    } finally {
      await manager.close();
    }
  });

  it("rejects changing the agent inside an existing conversation", async () => {
    const manager = new AcpSessionManager();
    const codex = new LocalAgentDefinition("codex", "Codex", process.execPath, [
      fakeAgentPath,
    ]);
    const claude = new LocalAgentDefinition(
      "claude",
      "Claude Code",
      process.execPath,
      [fakeAgentPath],
    );

    try {
      await manager.runPrompt({
        agent: codex,
        cwd: process.cwd(),
        onActivity: () => Promise.resolve(),
        onText: () => Promise.resolve(),
        prompt: "first",
        sessionId: "locked-conversation",
        signal: new AbortController().signal,
      });
      await expect(
        manager.runPrompt({
          agent: claude,
          cwd: process.cwd(),
          onActivity: () => Promise.resolve(),
          onText: () => Promise.resolve(),
          prompt: "second",
          sessionId: "locked-conversation",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("agent cannot change");
    } finally {
      await manager.close();
    }
  });
});
