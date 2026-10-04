import { describe, expect, it } from "vitest";
import { AgentRuntimeManager, NullAcpSessionObserver } from "../../../packages/cli/src/acp/agent-runtime-manager.ts";
import { MemoryAcpSessionStore } from "../../../packages/cli/src/acp/session-store.ts";

import { fixture } from "./native-session-fixture.ts";

describe("native session identity", () => {
    it("Given a Mobius Session has a terminal recorded Turn, When Chat forks that Turn, Then the Runtime opens an independent child from the bound native Session", async () => {
        const f = await fixture("Claude Code");
        const signal = new AbortController().signal;
        const sourceSessionId = "recorded-fork-source";
        const throughCommandId = "recorded-fork-command";
        const targetSessionId = "recorded-fork-child";
        try {
            await f.sessions.runPrompt({
                agent: f.agent,
                additionalDirectories: [],
                cwd: f.workspace,
                signal,
                sessionId: sourceSessionId,
                commandId: throughCommandId,
                prompt: "Create source context",
                images: [],
                resources: [],
                onText: async () => {},
                onActivity: async () => {},
            });

            const result = await f.service.execute(
                {
                    ...f.identity,
                    action: "fork-recorded",
                    sessionId: sourceSessionId,
                    targetSessionId,
                    throughCommandId,
                },
                signal,
            );

            expect(result).toMatchObject({
                action: "fork-recorded",
                ready: { sessionId: targetSessionId },
                targetSessionId,
            });
            expect(await f.service.querySessions([targetSessionId], signal)).toMatchObject([
                { sessionId: targetSessionId },
            ]);
        } finally {
            await f.close();
        }
    });

    it.each(["import", "fork"] satisfies readonly ("import" | "fork")[])(
        "Given a %s assigned a UUID distinct from its native identity, When the Runtime restarts, Then that conversation remains discoverable and can continue",
        async (action) => {
            const f = await fixture("Claude Code", "supported", "native");
            try {
                await f.seed("Original context");
                const entry = (await f.list()).entries[0];
                if (entry === undefined) {
                    throw new Error("Missing native session");
                }
                const targetSessionId = crypto.randomUUID();
                await f.service.execute(
                    { ...f.identity, action, entryId: entry.entryId, targetSessionId },
                    new AbortController().signal,
                );
                await f.restart();
                expect(await f.service.querySessions([targetSessionId], new AbortController().signal)).toMatchObject([
                    { sessionId: targetSessionId },
                ]);
                const reply = await f.sessions.runPrompt({
                    agent: f.agent,
                    cwd: f.workspace,
                    additionalDirectories: [],
                    sessionId: targetSessionId,
                    commandId: crypto.randomUUID(),
                    prompt: "Continue original context",
                    images: [],
                    resources: [],
                    signal: new AbortController().signal,
                    onText: async () => {},
                    onActivity: async () => {},
                });
                expect(reply.stopReason).toBe("end_turn");
                expect((await f.list()).entries).toHaveLength(action === "fork" ? 2 : 1);
            } finally {
                await f.close();
            }
        },
    );

    // Keep distinct native identity/history paths; Pi uses the same ACP fixture path as Claude.
    it.each(["Claude Code", "OpenCode"])(
        "Given a new %s chat, When the Runtime restarts, Then its native ID resumes the saved thread and history",
        async (agentName) => {
            const f = await fixture(agentName, "supported", "native");
            const signal = new AbortController().signal;
            const created = await f.service.execute({ ...f.identity, action: "create" }, signal);
            if (created.action !== "create") {
                throw new Error("Expected a native Agent session");
            }
            const restarted = new AgentRuntimeManager(
                new NullAcpSessionObserver(),
                new MemoryAcpSessionStore(),
                null,
                "native",
            );
            try {
                await restarted.runPrompt({
                    agent: f.agent,
                    additionalDirectories: [],
                    cwd: f.workspace,
                    signal,
                    sessionId: created.nativeSessionId,
                    commandId: crypto.randomUUID(),
                    prompt: "Continue this chat",
                    images: [],
                    resources: [],
                    onText: async () => {},
                    onActivity: async () => {},
                });
                const history = await restarted.loadSessionHistory({
                    agent: f.agent,
                    additionalDirectories: [],
                    cwd: f.workspace,
                    signal,
                    sessionId: created.nativeSessionId,
                });
                expect(history).toMatchObject({
                    status: "available",
                    messages: expect.arrayContaining([{ role: "user", text: "Continue this chat" }]),
                });
            } finally {
                await restarted.close();
                await f.close();
            }
        },
    );

    it("Given Chat forks a native conversation into an assigned Session, When a post-fork turn completes and Chat reloads, Then Runtime history contains that turn", async () => {
        const f = await fixture("Claude Code");
        const signal = new AbortController().signal;
        try {
            await f.seed("Fork source");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const targetSessionId = "forked-history";
            await f.service.execute(
                {
                    ...f.identity,
                    action: "fork",
                    entryId: entry.entryId,
                    targetSessionId,
                },
                signal,
            );
            await f.sessions.runPrompt({
                agent: f.agent,
                additionalDirectories: [],
                cwd: f.workspace,
                signal,
                sessionId: targetSessionId,
                commandId: crypto.randomUUID(),
                prompt: "Post-fork turn",
                images: [],
                resources: [],
                onText: async () => {},
                onActivity: async () => {},
            });

            const history = await f.sessions.loadSessionHistory({
                agent: f.agent,
                additionalDirectories: [],
                cwd: f.workspace,
                signal,
                sessionId: targetSessionId,
            });

            expect(history).toMatchObject({
                status: "available",
                messages: expect.arrayContaining([{ role: "user", text: "Post-fork turn" }]),
            });
        } finally {
            await f.close();
        }
    });

    it("Given an Agent returns the original session as a fork, When a user requests an independent conversation, Then the invalid fork is rejected", async () => {
        const f = await fixture("Claude Code", "invalid-fork");
        try {
            await f.seed("Original context");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            await expect(
                f.service.execute(
                    {
                        ...f.identity,
                        action: "fork",
                        entryId: entry.entryId,
                        targetSessionId: "invalid-fork",
                    },
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({ code: "invalid_native_session_response" });
            expect((await f.list()).entries.map((session) => session.title)).toEqual(["Original context"]);
        } finally {
            await f.close();
        }
    });
});
