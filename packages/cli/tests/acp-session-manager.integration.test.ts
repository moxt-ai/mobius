import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AcpSessionManager,
  createWritableAcpStream,
} from "../src/acp/session-manager.ts";
import { SqliteAcpSessionStore } from "../src/acp/session-store.ts";
import { LocalAgentDefinition } from "../src/config.ts";

const fakeAgentPath = fileURLToPath(
  new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url),
);

describe("ACP conversation sessions", () => {
  it("Given a prepared conversation has no turns, When its agent selection changes, Then the same Mobius session is rebound before the first prompt", async () => {
    const manager = new AcpSessionManager();
    const codex = new LocalAgentDefinition("codex", "Codex", process.execPath, [
      fakeAgentPath,
      "--agent-name",
      "Codex",
    ]);
    const claude = new LocalAgentDefinition(
      "claude",
      "Claude Code",
      process.execPath,
      [fakeAgentPath, "--agent-name", "Claude Code"],
    );

    try {
      await manager.prepareSession({
        additionalDirectories: [],
        agent: codex,
        cwd: process.cwd(),
        sessionId: "rebound-conversation",
        signal: new AbortController().signal,
      });
      await expect(
        manager.prepareSession({
          additionalDirectories: [],
          agent: claude,
          cwd: process.cwd(),
          sessionId: "rebound-conversation",
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ restored: false });

      const chunks: string[] = [];
      await manager.runPrompt({
        additionalDirectories: [],
        agent: claude,
        commandId: "command-after-rebind",
        cwd: process.cwd(),
        images: [],
        onActivity: () => Promise.resolve(),
        onText: (text) => {
          chunks.push(text);
          return Promise.resolve();
        },
        prompt: "selected agent",
        resources: [],
        sessionId: "rebound-conversation",
        signal: new AbortController().signal,
      });
      expect(chunks.join("")).toBe("Claude Code turn 1: selected agent");
    } finally {
      await manager.close();
    }
  });

  it("Given an unprompted ACP session survived a daemon restart, When its agent selection changes, Then the local runtime safely rebinds it", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-acp-empty-rebind-"),
    );
    const databasePath = join(temporaryDirectory, "sessions.sqlite");
    const codex = new LocalAgentDefinition("codex", "Codex", process.execPath, [
      fakeAgentPath,
      "--agent-name",
      "Codex",
    ]);
    const claude = new LocalAgentDefinition(
      "claude",
      "Claude Code",
      process.execPath,
      [fakeAgentPath, "--agent-name", "Claude Code"],
    );
    const signal = new AbortController().signal;

    try {
      const firstStore = new SqliteAcpSessionStore(databasePath);
      const first = new AcpSessionManager(undefined, firstStore);
      await first.prepareSession({
        additionalDirectories: [],
        agent: codex,
        cwd: temporaryDirectory,
        sessionId: "persisted-empty-conversation",
        signal,
      });
      await first.close();
      firstStore.close();

      const secondStore = new SqliteAcpSessionStore(databasePath);
      const second = new AcpSessionManager(undefined, secondStore);
      try {
        await expect(
          second.prepareSession({
            additionalDirectories: [],
            agent: claude,
            cwd: temporaryDirectory,
            sessionId: "persisted-empty-conversation",
            signal,
          }),
        ).resolves.toMatchObject({ restored: false });
        const chunks: string[] = [];
        await second.runPrompt({
          additionalDirectories: [],
          agent: claude,
          commandId: "command-after-restart-rebind",
          cwd: temporaryDirectory,
          images: [],
          onActivity: () => Promise.resolve(),
          onText: (text) => {
            chunks.push(text);
            return Promise.resolve();
          },
          prompt: "selected after restart",
          resources: [],
          sessionId: "persisted-empty-conversation",
          signal,
        });
        expect(chunks.join("")).toBe(
          "Claude Code turn 1: selected after restart",
        );
      } finally {
        await second.close();
        secondStore.close();
      }
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

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
        additionalDirectories: [],
        agent,
        commandId: "command-first",
        cwd: process.cwd(),
        images: [],
        onActivity: () => Promise.resolve(),
        onText: (text) => {
          firstChunks.push(text);
          return Promise.resolve();
        },
        prompt: "first",
        resources: [],
        sessionId: "browser-conversation",
        signal: new AbortController().signal,
      });
      await manager.runPrompt({
        additionalDirectories: [],
        agent,
        commandId: "command-second",
        cwd: process.cwd(),
        images: [],
        onActivity: () => Promise.resolve(),
        onText: (text) => {
          secondChunks.push(text);
          return Promise.resolve();
        },
        prompt: "second",
        resources: [],
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
        additionalDirectories: [],
        agent,
        commandId: "command-cancelled",
        cwd: process.cwd(),
        images: [],
        onActivity: () => {
          activityStarted.resolve();
          return Promise.resolve();
        },
        onText: () => Promise.resolve(),
        prompt: "wait until cancelled",
        resources: [],
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
        additionalDirectories: [],
        agent,
        commandId: "command-continue",
        cwd: process.cwd(),
        images: [],
        onActivity: () => Promise.resolve(),
        onText: (text) => {
          nextChunks.push(text);
          return Promise.resolve();
        },
        prompt: "continue",
        resources: [],
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
        additionalDirectories: [],
        agent: codex,
        commandId: "command-locked-first",
        cwd: process.cwd(),
        images: [],
        onActivity: () => Promise.resolve(),
        onText: () => Promise.resolve(),
        prompt: "first",
        resources: [],
        sessionId: "locked-conversation",
        signal: new AbortController().signal,
      });
      await expect(
        manager.runPrompt({
          additionalDirectories: [],
          agent: claude,
          commandId: "command-locked-second",
          cwd: process.cwd(),
          images: [],
          onActivity: () => Promise.resolve(),
          onText: () => Promise.resolve(),
          prompt: "second",
          resources: [],
          sessionId: "locked-conversation",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("agent or workspace cannot change");
    } finally {
      await manager.close();
    }
  });

  it("Given an ACP subprocess exits during shutdown, When its session manager closes, Then the stream failure is contained", async () => {
    const manager = new AcpSessionManager();
    const agent = new LocalAgentDefinition("codex", "Codex", process.execPath, [
      fakeAgentPath,
      "--exit-after-session-creation",
    ]);
    const signal = new AbortController().signal;

    await manager.prepareSession({
      additionalDirectories: [],
      agent,
      cwd: process.cwd(),
      sessionId: "exited-conversation",
      signal,
    });
    await expect(
      manager.configureSession({
        additionalDirectories: [],
        agent,
        booleanValue: false,
        configId: "model",
        cwd: process.cwd(),
        requestId: "configure-exited-session",
        sessionId: "exited-conversation",
        signal,
        value: "test-large",
        valueType: "select",
      }),
    ).rejects.toThrow();

    await expect(manager.close()).resolves.toBeUndefined();
  });

  it("Given an ACP process pipe fails, When the protocol writes to it, Then the stream reports the failure without an uncaught process error", async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      },
    });
    const writer = createWritableAcpStream(output).getWriter();

    await expect(writer.write(new Uint8Array([1]))).rejects.toThrow(
      "broken pipe",
    );
  });
});
