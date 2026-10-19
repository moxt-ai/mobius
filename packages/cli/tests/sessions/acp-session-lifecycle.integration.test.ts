import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { decodeSessionEvent, MAX_CONTENT_LENGTH } from "@moxt-ai/mobius-sdk/protocol";
import { describe, expect, it, vi } from "vitest";

import { AgentRuntimeManager, acpAdapters, createWritableAcpStream } from "../../src/acp/agent-runtime-manager.ts";
import { NullAcpSessionObserver } from "../../src/acp/session-contracts.ts";
import { CachedAcpSessionEventStore } from "../../src/acp/session-event-store.ts";
import { FoundAcpStoredSession, MemoryAcpSessionStore, SqliteAcpSessionStore } from "../../src/acp/session-store.ts";
import { LocalAgentDefinition } from "../../src/daemon/config.ts";
import { systemDaemonTimer } from "../../src/daemon/relay/timer.ts";
import { AcpContentExternalizer } from "../../src/external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "../../src/external-content/local-external-content-store.ts";
import { acpSessionStoreMigrations } from "../../src/generated/acp-session-store-migrations.ts";
import { AccumulatingOperationMetrics } from "../../src/infra/operation-metrics.ts";
import { openAcpSessionDatabase, openSessionEventCacheDatabase } from "../../src/local-databases.ts";
import { SqliteSessionLiveEventPosition } from "../../src/session-live-event-position.ts";
import { RecordingObserver } from "./acp-feature-fixture.ts";

const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));

function processExists(pid: number): boolean {
    if (process.platform === "linux") {
        try {
            const encoded = readFileSync(join("/proc", pid.toString(), "stat"), "utf8");
            const closingParenthesis = encoded.lastIndexOf(")");
            const state = encoded
                .slice(closingParenthesis + 1)
                .trimStart()
                .charAt(0);
            if (state === "Z" || state === "X") {
                return false;
            }
        } catch {
            // Fall through when procfs is unavailable or the process has already exited.
        }
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            return false;
        }
        throw error;
    }
}

describe("ACP conversation sessions", () => {
    it("Given an inactive existing conversation, When it is reopened, Then its directory activity time stays unchanged", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const store = new MemoryAcpSessionStore();
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-activity-time-"));
        const agent = new LocalAgentDefinition(
            "codex",
            "Codex",
            process.execPath,
            [fakeAgentPath, "--agent-name", "Codex"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: temporaryDirectory },
        );
        const firstManager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store,
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        const signal = new AbortController().signal;

        try {
            vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
            await firstManager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "initial-command",
                cwd: process.cwd(),
                images: [],
                prompt: "initial activity",
                resources: [],
                sessionId: "existing-conversation",
                signal,
            });
            const initial = store.read("existing-conversation");
            if (!(initial instanceof FoundAcpStoredSession)) {
                throw new Error("Expected the conversation to be stored");
            }
            await firstManager.close();

            vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
            const reopenedManager = new AgentRuntimeManager({
                observer: new NullAcpSessionObserver(),
                store,
                adapters: acpAdapters,
                sessionIdentity: "assigned",
                onSessionStatusChanged: () => undefined,
                contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
                timer: systemDaemonTimer,
                maxProcesses: null,
            });
            try {
                await reopenedManager.prepareSession({
                    additionalDirectories: [],
                    agent,
                    cwd: process.cwd(),
                    sessionId: "existing-conversation",
                    signal,
                });
                const reopened = store.read("existing-conversation");
                if (!(reopened instanceof FoundAcpStoredSession)) {
                    throw new Error("Expected the reopened conversation to remain stored");
                }
                expect(reopened.session.updatedAt).toBe(initial.session.updatedAt);

                await reopenedManager.runPrompt({
                    additionalDirectories: [],
                    agent,
                    commandId: "new-command",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "new activity",
                    resources: [],
                    sessionId: "existing-conversation",
                    signal,
                });
                const active = store.read("existing-conversation");
                if (!(active instanceof FoundAcpStoredSession)) {
                    throw new Error("Expected the active conversation to remain stored");
                }
                expect(active.session.updatedAt).toBe("2026-10-14T12:00:00.000Z");
            } finally {
                await reopenedManager.close();
            }
        } finally {
            vi.useRealTimers();
            await firstManager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a database-backed live position allocation, When the event store reopens, Then allocation continues from ten thousand", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-session-live-event-position-"));
        const sessionDatabasePath = join(temporaryDirectory, "sessions.sqlite");
        const firstSessionDatabase = openAcpSessionDatabase(sessionDatabasePath);
        const first = new CachedAcpSessionEventStore(
            openSessionEventCacheDatabase(join(temporaryDirectory, "first-events.sqlite")),
            new SqliteSessionLiveEventPosition(firstSessionDatabase),
        );
        try {
            expect(
                [
                    first.append("session-1", {
                        payload: { kind: "session.queue.changed" },
                        type: "lifecycle-metadata",
                    }),
                    first.append("session-1", {
                        payload: { kind: "session.queue.changed" },
                        type: "lifecycle-metadata",
                    }),
                    first.append("session-2", {
                        payload: { kind: "session.queue.changed" },
                        type: "lifecycle-metadata",
                    }),
                ].map((event) => event.position),
            ).toEqual(["10000", "10001", "10000"]);
        } finally {
            first.close();
            firstSessionDatabase.close();
        }

        const secondSessionDatabase = openAcpSessionDatabase(sessionDatabasePath);
        const second = new CachedAcpSessionEventStore(
            openSessionEventCacheDatabase(join(temporaryDirectory, "second-events.sqlite")),
            new SqliteSessionLiveEventPosition(secondSessionDatabase),
        );
        try {
            expect(
                second.append("session-1", {
                    payload: { kind: "session.queue.changed" },
                    type: "lifecycle-metadata",
                }).position,
            ).toBe("10002");
        } finally {
            second.close();
            secondSessionDatabase.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a projected tool has flushed to SQLite, When more live updates arrive, Then history replaces that Session event while keeping the projected live identity", async () => {
        vi.useFakeTimers({ toFake: ["clearImmediate", "setImmediate"] });
        vi.setSystemTime(new Date("2026-10-12T00:00:00.000Z"));
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-session-event-tool-projection-"));
        const sessionDatabase = openAcpSessionDatabase(join(temporaryDirectory, "sessions.sqlite"));
        const store = new CachedAcpSessionEventStore(
            openSessionEventCacheDatabase(join(temporaryDirectory, "events.sqlite")),
            new SqliteSessionLiveEventPosition(sessionDatabase),
        );
        try {
            const liveEvents = [
                store.append("session-1", {
                    payload: {
                        sessionUpdate: "tool_call",
                        title: "Run command",
                        toolCallId: "tool-1",
                    },
                    type: "acp",
                }),
            ];
            liveEvents.push(
                store.append("session-1", {
                    payload: {
                        rawOutput: { output: "first snapshot" },
                        sessionUpdate: "tool_call_update",
                        status: "in_progress",
                        toolCallId: "tool-1",
                    },
                    type: "acp",
                }),
            );
            for (let remaining = 298; remaining > 0; remaining -= 1) {
                store.append("session-1", {
                    payload: { kind: "session.queue.changed" },
                    type: "lifecycle-metadata",
                });
            }
            await vi.runAllTimersAsync();

            liveEvents.push(
                store.append("session-1", {
                    payload: {
                        content: [{ content: { text: "final snapshot", type: "text" }, type: "content" }],
                        sessionUpdate: "tool_call_update",
                        status: "completed",
                        toolCallId: "tool-1",
                    },
                    type: "acp",
                }),
            );

            const page = store.page("session-1", 400, null);
            const toolEvents = page.events.filter(
                (event) =>
                    event.type === "acp" &&
                    (event.payload.sessionUpdate === "tool_call" || event.payload.sessionUpdate === "tool_call_update"),
            );
            expect(toolEvents).toHaveLength(1);
            expect(toolEvents[0]).toMatchObject({
                payload: {
                    content: [{ content: { text: "final snapshot", type: "text" }, type: "content" }],
                    rawOutput: { output: "first snapshot" },
                    sessionUpdate: "tool_call",
                    status: "completed",
                    title: "Run command",
                    toolCallId: "tool-1",
                },
                type: "acp",
            });
            expect(liveEvents.map((event) => event.eventId)).toContain(toolEvents[0]?.eventId);
        } finally {
            store.close();
            sessionDatabase.close();
            vi.useRealTimers();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given more V2 events than the memory tier retains, When history is paged after background caching, Then one ordered sequence is returned", async () => {
        vi.useFakeTimers({ toFake: ["clearImmediate", "setImmediate"] });
        vi.setSystemTime(new Date("2026-10-09T00:00:00.000Z"));
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-session-event-tiering-"));
        const sessionDatabase = openAcpSessionDatabase(join(temporaryDirectory, "sessions.sqlite"));
        const store = new CachedAcpSessionEventStore(
            openSessionEventCacheDatabase(join(temporaryDirectory, "events.sqlite")),
            new SqliteSessionLiveEventPosition(sessionDatabase),
        );
        try {
            for (let position = 1; position <= 300; position += 1) {
                store.append("session-1", {
                    payload: {
                        commandId: `command-${position.toString()}`,
                        content: [{ text: `prompt ${position.toString()}`, type: "text" }],
                        kind: "prompt.requested",
                    },
                    type: "lifecycle-metadata",
                });
            }
            await vi.runAllTimersAsync();

            const page = store.page("session-1", 200, null);
            expect(page.events).toHaveLength(200);
            expect(page.events[0]).toMatchObject({ payload: { commandId: "command-101" } });
            expect(page.events.at(-1)).toMatchObject({ payload: { commandId: "command-300" } });
        } finally {
            store.close();
            sessionDatabase.close();
            vi.useRealTimers();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given projected history spanning cache tiers, When newer events arrive between pages, Then the event-ID cursor resumes before the same event", async () => {
        vi.useFakeTimers({ toFake: ["clearImmediate", "setImmediate"] });
        vi.setSystemTime(new Date("2026-10-14T00:00:00.000Z"));
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-session-event-cursor-"));
        const sessionDatabase = openAcpSessionDatabase(join(temporaryDirectory, "sessions.sqlite"));
        const store = new CachedAcpSessionEventStore(
            openSessionEventCacheDatabase(join(temporaryDirectory, "events.sqlite")),
            new SqliteSessionLiveEventPosition(sessionDatabase),
        );
        try {
            for (let eventNumber = 1; eventNumber <= 300; eventNumber += 1) {
                store.append("session-1", {
                    payload: {
                        commandId: `command-${eventNumber.toString()}`,
                        content: [{ text: `prompt ${eventNumber.toString()}`, type: "text" }],
                        kind: "prompt.requested",
                    },
                    type: "lifecycle-metadata",
                });
            }
            await vi.runAllTimersAsync();

            const newest = store.page("session-1", 150, null);
            expect(newest.events[0]).toMatchObject({ payload: { commandId: "command-151" } });
            expect(newest.nextCursor).toBe(newest.events[0]?.eventId);

            store.append("session-1", {
                payload: {
                    commandId: "command-301",
                    content: [{ text: "newer prompt", type: "text" }],
                    kind: "prompt.requested",
                },
                type: "lifecycle-metadata",
            });

            const older = store.page("session-1", 150, newest.nextCursor);
            expect(older.events).toHaveLength(150);
            expect(older.events[0]).toMatchObject({ payload: { commandId: "command-1" } });
            expect(older.events.at(-1)).toMatchObject({ payload: { commandId: "command-150" } });
            expect(older.nextCursor).toBeNull();
        } finally {
            store.close();
            sessionDatabase.close();
            vi.useRealTimers();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given V2 Session events cached by one process, When a new process opens the cache, Then stale V2 events are unavailable under a new Session generation", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-session-event-cache-"));
        const databasePath = join(temporaryDirectory, "events.sqlite");
        const sessionDatabasePath = join(temporaryDirectory, "sessions.sqlite");
        const firstSessionDatabase = openAcpSessionDatabase(sessionDatabasePath);
        const first = new CachedAcpSessionEventStore(
            openSessionEventCacheDatabase(databasePath),
            new SqliteSessionLiveEventPosition(firstSessionDatabase),
        );
        let firstGeneration = "";
        try {
            first.append("session-1", {
                payload: {
                    commandId: "command-1",
                    content: [{ text: "cached prompt", type: "text" }],
                    kind: "prompt.requested",
                },
                type: "lifecycle-metadata",
            });
            first.append("session-1", {
                payload: {
                    content: { text: "cached update", type: "text" },
                    messageId: "message-1",
                    sessionUpdate: "user_message_chunk",
                },
                type: "acp",
            });
            const page = first.page("session-1", 10, null);
            firstGeneration = page.sessionGenerationId;
            expect(
                page.events.map(
                    ({
                        eventId: _eventId,
                        recordedAt: _recordedAt,
                        sessionGenerationId: _generation,
                        sessionId: _sessionId,
                        ...event
                    }) => event,
                ),
            ).toEqual([
                {
                    payload: {
                        commandId: "command-1",
                        content: [{ text: "cached prompt", type: "text" }],
                        kind: "prompt.requested",
                    },
                    type: "lifecycle-metadata",
                },
                {
                    payload: {
                        content: { text: "cached update", type: "text" },
                        messageId: "message-1",
                        sessionUpdate: "user_message_chunk",
                    },
                    type: "acp",
                },
            ]);
        } finally {
            first.close();
            firstSessionDatabase.close();
        }

        const secondSessionDatabase = openAcpSessionDatabase(sessionDatabasePath);
        const second = new CachedAcpSessionEventStore(
            openSessionEventCacheDatabase(databasePath),
            new SqliteSessionLiveEventPosition(secondSessionDatabase),
        );
        try {
            const page = second.page("session-1", 10, null);
            expect(page.sessionGenerationId).not.toBe(firstGeneration);
            expect(page.events).toEqual([]);
        } finally {
            second.close();
            secondSessionDatabase.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given an ACP Session database from the persisted-event release, When Mobius opens it, Then the unused event table is removed", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-session-store-migration-"));
        const databasePath = join(temporaryDirectory, "sessions.sqlite");
        const legacyDatabase = new DatabaseSync(databasePath);
        try {
            for (const migration of acpSessionStoreMigrations.slice(0, -1)) {
                legacyDatabase.exec(migration.sql);
            }
            legacyDatabase.exec(`PRAGMA user_version = ${acpSessionStoreMigrations.length - 1}`);
        } finally {
            legacyDatabase.close();
        }

        const store = new SqliteAcpSessionStore(openAcpSessionDatabase(databasePath));
        store.close();
        const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
        try {
            expect(
                migratedDatabase
                    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_event_v2'")
                    .get(),
            ).toBeUndefined();
        } finally {
            migratedDatabase.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a managed Claude Code conversation, When the Runtime restarts, Then its Session remains discoverable", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-session-store-"));
        const databasePath = join(temporaryDirectory, "sessions.sqlite");
        const sessionId = `chat_${"a".repeat(64)}`;
        const agent = new LocalAgentDefinition("claude", "Claude Code", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Claude Code",
        ]);
        const signal = new AbortController().signal;
        const firstStore = new SqliteAcpSessionStore(openAcpSessionDatabase(databasePath));
        const firstRuntime = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: firstStore,
            adapters: acpAdapters,
            sessionIdentity: "native",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });

        try {
            await firstRuntime.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "claude-first-turn",
                cwd: process.cwd(),
                images: [],
                prompt: "Remember this conversation",
                resources: [],
                sessionId,
                signal,
            });
        } finally {
            await firstRuntime.close();
            firstStore.close();
        }

        const restartedStore = new SqliteAcpSessionStore(openAcpSessionDatabase(databasePath));
        const restartedRuntime = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: restartedStore,
            adapters: acpAdapters,
            sessionIdentity: "native",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        try {
            expect(restartedRuntime.findSessions([sessionId])).toEqual([
                expect.objectContaining({ agentId: "claude", prompted: true, sessionId }),
            ]);
        } finally {
            await restartedRuntime.close();
            restartedStore.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it.skipIf(process.platform === "win32")(
        "Given an ACP Turn keeps running, When it is cancelled, Then Mobius keeps its Agent process for the next Turn",
        async () => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-long-turn-"));
            const adapterPath = join(temporaryDirectory, "pi-acp");
            const piPidPath = join(temporaryDirectory, "pi.pid");
            await writeFile(
                adapterPath,
                `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const pidPath = process.env.MOBIUS_TEST_PI_PID_FILE;
if (pidPath === undefined) process.exit(81);
const child = spawn(process.execPath, [${JSON.stringify(fakeAgentPath)}, "--agent-name", "Pi"], {
  env: process.env,
  stdio: "inherit",
});
if (child.pid === undefined) process.exit(82);
writeFileSync(pidPath, child.pid.toString());
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.once("error", () => process.exit(83));
child.once("exit", (code) => process.exit(code ?? 84));
`,
                { mode: 0o700 },
            );
            await chmod(adapterPath, 0o700);
            vi.useFakeTimers({ toFake: ["clearTimeout", "setTimeout"] });
            const manager = new AgentRuntimeManager({
                observer: new NullAcpSessionObserver(),
                store: new MemoryAcpSessionStore(),
                adapters: acpAdapters,
                sessionIdentity: "assigned",
                onSessionStatusChanged: () => undefined,
                contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
                timer: systemDaemonTimer,
                maxProcesses: null,
            });
            const adapterBaseline = new LocalAgentDefinition("pi", "Pi", adapterPath, []);
            const agentBaseline = new LocalAgentDefinition("pi", "Pi", process.execPath, []);
            const agent = new LocalAgentDefinition(
                "pi",
                "Pi",
                adapterPath,
                [],
                { MOBIUS_TEST_PI_PID_FILE: piPidPath },
                "0.0.33",
                "0.85.0",
                adapterBaseline.adapterIdentity,
                agentBaseline.agentIdentity,
            );
            const observer = new RecordingObserver();
            manager.setObserver(observer);

            try {
                const hangingTurn = manager.runPrompt({
                    additionalDirectories: [],
                    agent,
                    commandId: "pi-hanging-command",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "wait until cancelled",
                    resources: [],
                    sessionId: "pi-hanging-conversation",
                    signal: new AbortController().signal,
                });
                let settled = false;
                void hangingTurn.then(
                    () => {
                        settled = true;
                    },
                    () => {
                        settled = true;
                    },
                );
                await observer.turnStarted();

                await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1_000);

                const piPid = Number.parseInt(await readFile(piPidPath, "utf8"), 10);
                expect(Number.isSafeInteger(piPid)).toBe(true);
                expect(settled).toBe(false);
                expect(processExists(piPid)).toBe(true);

                await manager.cancelPrompt("pi-hanging-conversation");

                await expect(hangingTurn).resolves.toEqual({ stopReason: "cancelled" });
                expect(processExists(piPid)).toBe(true);
                observer.events.length = 0;
                await manager.runPrompt({
                    additionalDirectories: [],
                    agent,
                    commandId: "pi-after-cancellation",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "continue in the retained process",
                    resources: [],
                    sessionId: "pi-hanging-conversation",
                    signal: new AbortController().signal,
                });
                expect(observer.agentText()).toBe("Pi turn 2: continue in the retained process");
                expect(processExists(piPid)).toBe(true);
            } finally {
                vi.useRealTimers();
                await manager.close();
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );

    it("Given a prepared conversation has no turns, When its agent selection changes, Then the same Mobius session is rebound before the first prompt", async () => {
        const manager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        const codex = new LocalAgentDefinition("codex", "Codex", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Codex",
        ]);
        const claude = new LocalAgentDefinition("claude", "Claude Code", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Claude Code",
        ]);

        try {
            await manager.prepareSession({
                additionalDirectories: [],
                agent: codex,
                cwd: process.cwd(),
                sessionId: "rebound-conversation",
                signal: new AbortController().signal,
            });
            const metrics = new AccumulatingOperationMetrics();
            await expect(
                manager.prepareSession(
                    {
                        additionalDirectories: [],
                        agent: claude,
                        cwd: process.cwd(),
                        sessionId: "rebound-conversation",
                        signal: new AbortController().signal,
                    },
                    metrics,
                ),
            ).resolves.toMatchObject({ restored: false });
            expect(metrics.snapshot()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: "runtime-replacement-close" }),
                    expect.objectContaining({ name: "session-new" }),
                ]),
            );

            const observer = new RecordingObserver();
            manager.setObserver(observer);
            await manager.runPrompt({
                additionalDirectories: [],
                agent: claude,
                commandId: "command-after-rebind",
                cwd: process.cwd(),
                images: [],
                prompt: "selected agent",
                resources: [],
                sessionId: "rebound-conversation",
                signal: new AbortController().signal,
            });
            expect(observer.agentText()).toBe("Claude Code turn 1: selected agent");
        } finally {
            await manager.close();
        }
    });

    it("Given Controlled ACP emits untagged messages before a tool call, When they arrive, Then each update is recorded live without waiting for the tool boundary", async () => {
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager({
            observer,
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        const agent = new LocalAgentDefinition("controlled-acp", "Controlled ACP", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Controlled ACP",
        ]);

        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "controlled-acp-interleaved-command",
                cwd: process.cwd(),
                images: [],
                prompt: "interleave untagged progress",
                resources: [],
                sessionId: "controlled-acp-interleaved-conversation",
                signal: new AbortController().signal,
            });
        } finally {
            await manager.close();
        }

        expect(
            observer
                .acpUpdates()
                .map((update) =>
                    (update.sessionUpdate === "agent_message_chunk" ||
                        update.sessionUpdate === "agent_thought_chunk") &&
                    update.content.type === "text"
                        ? { messageId: update.messageId ?? "", text: update.content.text }
                        : null,
                )
                .filter((entry): entry is { messageId: string; text: string } => entry !== null),
        ).toEqual([
            { messageId: "progress-1", text: "Gathering context" },
            { messageId: "reasoning-1", text: "Inspecting " },
            { messageId: "reasoning-1", text: "the workspace" },
            { messageId: "intermediate-1-1", text: "Checking the workspace" },
            { messageId: "intermediate-1-2", text: "Preparing the next tool call" },
            { messageId: "assistant-1", text: "Controlled ACP turn 1: " },
            { messageId: "assistant-1", text: "interleave untagged progress" },
        ]);
        expect(observer.toolUpdates("tool-1").at(0)).toMatchObject({
            sessionUpdate: "tool_call",
            status: "in_progress",
            title: "Read package metadata",
        });
        expect(observer.toolUpdates("tool-1").at(-1)).toMatchObject({
            sessionUpdate: "tool_call_update",
            status: "completed",
            rawOutput: { name: "mobius-workspace" },
        });
    });

    it("Given the least recently used conversation has an active turn, When an eleventh conversation starts, Then the active process is retained and the oldest idle process is released", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-active-process-lru-"));
        const store = new MemoryAcpSessionStore();
        // The scenario exercises retirement at the boundary, so it pins the
        // retained process budget instead of inheriting the production default.
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager({
            observer,
            store,
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: 10,
        });
        const agent = new LocalAgentDefinition(
            "codex",
            "Codex",
            process.execPath,
            [fakeAgentPath, "--agent-name", "Codex", "--exclusive-writer"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: temporaryDirectory },
        );
        const signal = new AbortController().signal;
        const activeTurn = manager.runPrompt({
            additionalDirectories: [],
            agent,
            commandId: "conversation-1-active",
            cwd: temporaryDirectory,
            images: [],
            prompt: "wait until cancelled",
            resources: [],
            sessionId: "conversation-1",
            signal,
        });
        const activityStarted = observer.waitForEvent(() =>
            observer.events.some(
                ({ event }) => event.type === "acp" && event.payload.sessionUpdate === "agent_thought_chunk",
            ),
        );
        const runTurn = async (sessionId: string): Promise<void> => {
            await manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: `${sessionId}-turn`,
                cwd: temporaryDirectory,
                images: [],
                prompt: "first",
                resources: [],
                sessionId,
                signal,
            });
        };
        const writerName = (sessionId: string): string => {
            const stored = store.read(sessionId);
            if (!(stored instanceof FoundAcpStoredSession)) {
                throw new Error(`Expected ${sessionId} to have a persisted native session`);
            }
            return `${encodeURIComponent(stored.session.nativeSessionId)}.writer`;
        };

        try {
            await activityStarted;
            for (let index = 2; index <= 10; index += 1) {
                await runTurn(`conversation-${index.toString()}`);
            }
            const activeWriter = writerName("conversation-1");
            const oldestIdleWriter = writerName("conversation-2");

            await runTurn("conversation-11");

            const activeWriters = (await readdir(temporaryDirectory)).filter((name) => name.endsWith(".writer"));
            expect(activeWriters).toHaveLength(10);
            expect(activeWriters).toContain(activeWriter);
            expect(activeWriters).not.toContain(oldestIdleWriter);
            await manager.cancelPrompt("conversation-1");
            await expect(activeTurn).resolves.toEqual({ stopReason: "cancelled" });
        } finally {
            await manager.cancelPrompt("conversation-1");
            await activeTurn.catch(() => undefined);
            await manager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given an ACP agent announces a different session while creating one, When Mobius receives the created session, Then the local boundary rejects the queued update", async () => {
        const manager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        const agent = new LocalAgentDefinition("controlled-acp", "Controlled ACP", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Controlled ACP",
            "--announce-config-while-creating",
            "--announce-wrong-session-while-creating",
        ]);

        try {
            await expect(
                manager.prepareSession({
                    additionalDirectories: [],
                    agent,
                    cwd: process.cwd(),
                    sessionId: "controlled-acp-wrong-session-notification",
                    signal: new AbortController().signal,
                }),
            ).rejects.toMatchObject({ code: "invalid_agent_session" });
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP agent returns the standard authentication error, When Mobius starts its session, Then the local boundary preserves an authentication-required code", async () => {
        const manager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        const agent = new LocalAgentDefinition("controlled-acp", "Controlled ACP", process.execPath, [
            fakeAgentPath,
            "--authentication-required",
        ]);

        try {
            await expect(
                manager.prepareSession({
                    additionalDirectories: [],
                    agent,
                    cwd: process.cwd(),
                    sessionId: "authentication-required-session",
                    signal: new AbortController().signal,
                }),
            ).rejects.toMatchObject({ code: "authentication_required" });
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP agent rejects a prompt with a non-authentication error, When Mobius runs that turn, Then the local boundary preserves the agent's real failure reason", async () => {
        const manager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        const agent = new LocalAgentDefinition("controlled-acp", "Controlled ACP", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Controlled ACP",
        ]);

        try {
            await expect(
                manager.runPrompt({
                    additionalDirectories: [],
                    agent,
                    commandId: "command-model-unavailable",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "fail with model unavailable",
                    resources: [],
                    sessionId: "model-unavailable-session",
                    signal: new AbortController().signal,
                }),
            ).rejects.toMatchObject({
                code: "acp_agent_error",
                message: "Internal error: Model unavailable: controlled/test-model",
            });
        } finally {
            await manager.close();
        }
    });

    it("Given Codex includes an invalid-prompt detail in an internal ACP error, When Mobius runs that turn, Then the user receives the actionable detail", async () => {
        const manager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        const agent = new LocalAgentDefinition("codex", "Codex", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Codex",
        ]);

        try {
            await expect(
                manager.runPrompt({
                    additionalDirectories: [],
                    agent,
                    commandId: "command-invalid-prompt",
                    cwd: process.cwd(),
                    images: [],
                    prompt: "fail with invalid prompt detail",
                    resources: [],
                    sessionId: "invalid-prompt-session",
                    signal: new AbortController().signal,
                }),
            ).rejects.toMatchObject({
                code: "acp_agent_error",
                message: "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
            });
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP Agent has a tool subprocess, When the turn is cancelled, Then Mobius retains the process tree until Runtime shutdown", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-cancel-tree-"));
        const observer = new RecordingObserver();
        const manager = new AgentRuntimeManager({
            observer,
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        const adapterPath = join(temporaryDirectory, "codex-acp.mjs");
        const childPidPath = join(temporaryDirectory, "tool-child.pid");
        await writeFile(
            adapterPath,
            `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const childPidPath = process.env.MOBIUS_TEST_CHILD_PID_FILE;
if (childPidPath === undefined) process.exit(81);
const tool = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60000)"], {
  detached: true,
  windowsHide: true,
  env: process.env,
  stdio: "ignore",
});
if (tool.pid === undefined) process.exit(82);
writeFileSync(childPidPath, tool.pid.toString());
const agent = spawn(process.execPath, [${JSON.stringify(fakeAgentPath)}, "--agent-name", "Codex"], {
  env: process.env,
  stdio: "inherit",
});
agent.once("error", () => process.exit(83));
agent.once("exit", (code) => process.exit(code ?? 84));
`,
            { mode: 0o700 },
        );
        await chmod(adapterPath, 0o700);
        const agent = new LocalAgentDefinition("codex", "Codex", process.execPath, [adapterPath], {
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: temporaryDirectory,
            MOBIUS_TEST_CHILD_PID_FILE: childPidPath,
        });
        let childPid = 0;

        try {
            const cancelledTurn = manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "command-cancelled-tree",
                cwd: temporaryDirectory,
                images: [],
                prompt: "wait until cancelled",
                resources: [],
                sessionId: "cancelled-tree-conversation",
                signal: new AbortController().signal,
            });
            await observer.turnStarted();
            childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
            expect(Number.isSafeInteger(childPid)).toBe(true);

            await manager.cancelPrompt("cancelled-tree-conversation");

            await expect(cancelledTurn).resolves.toEqual({
                stopReason: "cancelled",
            });
            expect(processExists(childPid)).toBe(true);
            observer.events.length = 0;
            await manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "command-after-tree-cancel",
                cwd: temporaryDirectory,
                images: [],
                prompt: "continue",
                resources: [],
                sessionId: "cancelled-tree-conversation",
                signal: new AbortController().signal,
            });
            expect(observer.agentText()).toBe("Codex turn 2: continue");
            expect(processExists(childPid)).toBe(true);
            await manager.close();
            expect(processExists(childPid)).toBe(false);
        } finally {
            await manager.close();
            if (childPid > 0 && processExists(childPid)) {
                try {
                    process.kill(process.platform === "win32" ? childPid : -childPid, "SIGKILL");
                } catch {
                    // A concurrently exited test process no longer needs cleanup.
                }
            }
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given an existing Agent conversation, When a caller changes its Agent identity, Then the local boundary rejects the request", async () => {
        const manager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
        const codex = new LocalAgentDefinition("codex", "Codex", process.execPath, [fakeAgentPath]);
        const claude = new LocalAgentDefinition("claude", "Claude Code", process.execPath, [fakeAgentPath]);

        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: codex,
                commandId: "command-locked-first",
                cwd: process.cwd(),
                images: [],
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
        const manager = new AgentRuntimeManager({
            observer: new NullAcpSessionObserver(),
            store: new MemoryAcpSessionStore(),
            adapters: acpAdapters,
            sessionIdentity: "assigned",
            onSessionStatusChanged: () => undefined,
            contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
            timer: systemDaemonTimer,
            maxProcesses: null,
        });
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

        await expect(writer.write(new Uint8Array([1]))).rejects.toThrow("broken pipe");
    });

    it("Given one message streams more reasoning than the protocol content bound, When history is read, Then it returns bounded events that preserve every character in order", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-session-reasoning-bound-"));
        const sessionDatabase = openAcpSessionDatabase(join(temporaryDirectory, "sessions.sqlite"));
        const store = new CachedAcpSessionEventStore(
            openSessionEventCacheDatabase(join(temporaryDirectory, "events.sqlite")),
            new SqliteSessionLiveEventPosition(sessionDatabase),
        );
        try {
            const chunkText = "0123456789".repeat(1_000);
            const chunkCount = 200;
            for (let chunk = 0; chunk < chunkCount; chunk += 1) {
                store.append("session-1", {
                    payload: {
                        content: { text: chunkText, type: "text" },
                        messageId: "reasoning-message",
                        sessionUpdate: "agent_thought_chunk",
                    },
                    type: "acp",
                });
            }

            const page = store.page("session-1", 1_000, null);
            const texts = page.events.map((event) => {
                if (event.type !== "acp" || event.payload.sessionUpdate !== "agent_thought_chunk") {
                    throw new Error("Expected merged reasoning events");
                }
                if (event.payload.content.type !== "text") {
                    throw new Error("Expected text reasoning content");
                }
                return event.payload.content.text;
            });

            expect(texts.length).toBeGreaterThan(1);
            for (const text of texts) {
                expect(text.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
            }
            expect(texts.join("")).toBe(chunkText.repeat(chunkCount));
            for (const event of page.events) {
                expect(() => decodeSessionEvent(JSON.parse(JSON.stringify(event)))).not.toThrow();
            }
        } finally {
            store.close();
            sessionDatabase.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
