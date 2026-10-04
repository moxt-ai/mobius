import { existsSync, watch } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeSessionCommand } from "@moxt-ai/mobius-protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeManager } from "../../../packages/cli/src/acp/agent-runtime-manager.ts";

import { fixture } from "./native-session-fixture.ts";

describe("native session preparation", () => {
    it("Given shared preparation is loading, When one waiter cancels, Then it fails without cancelling the owner", async () => {
        const f = await fixture("Claude Code", "load-only");
        const owner = new AbortController();
        try {
            const nativeSessionId = await f.seed("Shared preparation");
            await writeFile(join(f.native, "pause-load"), "");
            const options = {
                agent: f.agent,
                cwd: f.workspace,
                additionalDirectories: [],
                sessionId: "shared-loading",
                signal: owner.signal,
                origin: { kind: "import", nativeSessionId },
            } as const;
            const paused = Promise.withResolvers<void>();
            const watcher = watch(f.native, () => {
                if (existsSync(join(f.native, "load-paused"))) {
                    watcher.close();
                    paused.resolve();
                }
            });
            const preparing = f.sessions.prepareSession(options);
            await paused.promise;
            const waiter = new AbortController();
            const cancelled = f.sessions.prepareSession({ ...options, signal: waiter.signal }).then(
                () => "completed",
                () => "cancelled",
            );
            waiter.abort();
            await rm(join(f.native, "pause-load"));
            await preparing;
            expect(await cancelled).toBe("cancelled");
        } finally {
            owner.abort();
            await f.close();
        }
    });

    it("Given preparation is still loading, When the Runtime closes, Then preparation cannot return a live conversation", async () => {
        const f = await fixture("Claude Code", "load-only");
        const owner = new AbortController();
        try {
            const nativeSessionId = await f.seed("Closing preparation");
            await writeFile(join(f.native, "pause-load"), "");
            const paused = Promise.withResolvers<void>();
            const watcher = watch(f.native, () => {
                if (existsSync(join(f.native, "load-paused"))) {
                    watcher.close();
                    paused.resolve();
                }
            });
            const preparing = f.sessions
                .prepareSession({
                    agent: f.agent,
                    cwd: f.workspace,
                    additionalDirectories: [],
                    sessionId: "closing-loading",
                    signal: owner.signal,
                    origin: { kind: "import", nativeSessionId },
                })
                .then(
                    () => "completed",
                    () => "cancelled",
                );
            await paused.promise;
            await f.sessions.close();
            await rm(join(f.native, "pause-load"), { force: true });
            expect(await preparing).toBe("cancelled");
        } finally {
            owner.abort();
            await f.close();
        }
    });

    it("Given a saved ACP conversation is open elsewhere, When a user imports it and retries after it closes, Then the original opening error is reported and the retry opens the conversation", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
        const f = await fixture("Claude Code", "exclusive-writer");
        const external = new AgentRuntimeManager();
        try {
            await external.runPrompt({
                agent: f.agent,
                additionalDirectories: [],
                cwd: f.workspace,
                signal: new AbortController().signal,
                sessionId: "external",
                commandId: "external-turn",
                prompt: "Saved conversation",
                images: [],
                resources: [],
                onText: async () => {},
                onActivity: async () => {},
            });
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const command = {
                ...f.identity,
                action: "import",
                entryId: entry.entryId,
                targetSessionId: "imported",
            } satisfies NativeSessionCommand;
            await expect(f.service.execute(command, new AbortController().signal)).rejects.toMatchObject({
                code: "acp_agent_error",
            });
            await external.close();
            expect(await f.service.execute(command, new AbortController().signal)).toMatchObject({
                action: "import",
                ready: { sessionId: "imported" },
            });
        } finally {
            await external.close();
            await f.close();
            vi.useRealTimers();
        }
    });
});
