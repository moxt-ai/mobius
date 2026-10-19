import { describe, expect, it } from "vitest";
import { AgentRuntimeManager, acpAdapters, NullAcpSessionObserver } from "../../src/acp/agent-runtime-manager.ts";
import { MemoryAcpSessionStore } from "../../src/acp/session-store.ts";
import { systemDaemonTimer } from "../../src/daemon/relay/timer.ts";
import { AcpContentExternalizer } from "../../src/external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "../../src/external-content/local-external-content-store.ts";

import { fixture } from "./native-session-fixture.ts";

describe("native session identity", () => {
    it("Given a native conversation was imported with its raw V2 events, When it is imported again, Then the canonical target reopens with the Agent-owned history unchanged", async () => {
        const f = await fixture("Claude Code");
        const signal = new AbortController().signal;
        try {
            await f.seed("Canonical V2 import");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const first = await f.service.execute(
                {
                    ...f.identity,
                    action: "import",
                    entryId: entry.entryId,
                    targetSessionId: "first-import-target",
                },
                signal,
            );
            if (first.action !== "import") {
                throw new Error("Expected a native import");
            }
            const initial = await f.sessions.loadSessionEvents(
                {
                    additionalDirectories: [],
                    agent: f.agent,
                    cwd: f.workspace,
                    sessionId: first.ready.sessionId,
                    signal,
                },
                10_000,
                null,
            );

            const repeated = await f.service.execute(
                {
                    ...f.identity,
                    action: "import",
                    entryId: entry.entryId,
                    requestId: "repeated-v2-import",
                    targetSessionId: "discarded-second-target",
                },
                signal,
            );

            expect(repeated).toMatchObject({
                action: "import",
                ready: { sessionId: first.ready.sessionId },
            });
            await expect(
                f.sessions.loadSessionEvents(
                    {
                        additionalDirectories: [],
                        agent: f.agent,
                        cwd: f.workspace,
                        sessionId: first.ready.sessionId,
                        signal,
                    },
                    10_000,
                    null,
                ),
            ).resolves.toEqual(initial);
        } finally {
            await f.close();
        }
    });

    it.each(["import", "fork"] as const)(
        "Given a native conversation has raw ACP replay records, When Chat requests %s, Then the target replays the Agent-owned updates in order",
        async (action) => {
            const f = await fixture("Claude Code");
            const signal = new AbortController().signal;
            try {
                await f.seed("V2 source context");
                const entry = (await f.list()).entries[0];
                if (entry === undefined) {
                    throw new Error("Missing native conversation");
                }
                const source = await f.sessions.previewNativeSessionEvents(
                    {
                        additionalDirectories: [],
                        agent: f.agent,
                        cwd: f.workspace,
                        sessionId: "source-preview",
                        signal,
                    },
                    entry.nativeSessionId,
                    10_000,
                    null,
                );
                const targetSessionId = `target-${action.endsWith("fork") ? "fork" : "import"}`;

                const result = await f.service.execute(
                    { ...f.identity, action, entryId: entry.entryId, targetSessionId },
                    signal,
                );
                const replayed = await f.sessions.loadSessionEvents(
                    {
                        additionalDirectories: [],
                        agent: f.agent,
                        cwd: f.workspace,
                        sessionId: targetSessionId,
                        signal,
                    },
                    10_000,
                    null,
                );

                expect(result).toMatchObject({ action, ready: { sessionId: targetSessionId }, targetSessionId });
                expect(replayed.events.map(({ payload }) => payload)).toEqual(
                    source.events.map(({ payload }) => payload),
                );
            } finally {
                await f.close();
            }
        },
    );

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
                });
                expect(reply.stopReason).toBe("end_turn");
                expect((await f.list()).entries).toHaveLength(action === "fork" ? 2 : 1);
            } finally {
                await f.close();
            }
        },
    );

    it.each(["Claude Code", "Pi"] as const)(
        "Given a new %s chat, When the Runtime restarts, Then its native ID resumes the saved thread and history",
        async (agentName) => {
            const f = await fixture(agentName, "supported", "native");
            const signal = new AbortController().signal;
            const nativeSessionId = await f.sessions.createNativeSession({
                agent: f.agent,
                cwd: f.workspace,
                additionalDirectories: [],
                sessionId: f.identity.sessionId,
                signal,
            });
            const restarted = new AgentRuntimeManager({
                observer: new NullAcpSessionObserver(),
                store: new MemoryAcpSessionStore(),
                adapters: acpAdapters,
                sessionIdentity: "native",
                onSessionStatusChanged: () => undefined,
                contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
                timer: systemDaemonTimer,
                maxProcesses: null,
            });
            try {
                await restarted.runPrompt({
                    agent: f.agent,
                    additionalDirectories: [],
                    cwd: f.workspace,
                    signal,
                    sessionId: nativeSessionId,
                    commandId: crypto.randomUUID(),
                    prompt: "Continue this chat",
                    images: [],
                    resources: [],
                });
                const replay = await restarted.loadSessionEvents(
                    {
                        agent: f.agent,
                        additionalDirectories: [],
                        cwd: f.workspace,
                        signal,
                        sessionId: nativeSessionId,
                    },
                    50,
                    null,
                );
                expect(
                    replay.events.flatMap((event) =>
                        event.type === "acp" &&
                        event.payload.sessionUpdate === "user_message_chunk" &&
                        event.payload.content.type === "text"
                            ? [event.payload.content.text]
                            : [],
                    ),
                ).toContain("Continue this chat");
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
            });

            const replay = await f.sessions.loadSessionEvents(
                {
                    agent: f.agent,
                    additionalDirectories: [],
                    cwd: f.workspace,
                    signal,
                    sessionId: targetSessionId,
                },
                50,
                null,
            );

            expect(
                replay.events.flatMap((event) =>
                    event.type === "acp" &&
                    event.payload.sessionUpdate === "user_message_chunk" &&
                    event.payload.content.type === "text"
                        ? [event.payload.content.text]
                        : [],
                ),
            ).toContain("Post-fork turn");
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
