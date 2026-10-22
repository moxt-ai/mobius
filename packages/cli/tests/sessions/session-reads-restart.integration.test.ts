import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntimeManager } from "../../src/acp/agent-runtime-manager.ts";
import { AcpContentExternalizer } from "../../src/acp/content/content-externalizer.ts";
import { NullAcpSessionObserver } from "../../src/acp/session-contracts.ts";
import { MemoryAcpSessionStore, MissingAcpStoredSession, SqliteAcpSessionStore } from "../../src/acp/session-store.ts";
import { LocalAgentDefinition } from "../../src/runtime/config.ts";
import { openAcpSessionDatabase } from "../../src/storage/sqlite/local-databases.ts";
import { systemTimer } from "../../src/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";
import { fakeAgentPath } from "./acp-feature-fixture.ts";

async function controlledAgent(
    agentId: string,
    additionalArguments: readonly string[] = [],
): Promise<{ agent: LocalAgentDefinition; stateDirectory: string }> {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-session-config-reads-"));
    const agent = new LocalAgentDefinition(
        agentId,
        "Controlled ACP",
        process.execPath,
        [fakeAgentPath, ...additionalArguments],
        {
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: stateDirectory,
        },
    );
    return { agent, stateDirectory };
}

/** Seeds the fake peer's persisted native-session state for `session/load`. */
async function seedPeerSession(stateDirectory: string, sessionId: string): Promise<void> {
    await writeFile(
        join(stateDirectory, `${encodeURIComponent(sessionId)}.json`),
        JSON.stringify({
            fastMode: false,
            history: [],
            mode: "code",
            model: "test-small",
            reasoningEffort: "medium",
            turnCount: 0,
        }),
    );
}

function createManager(
    store: MemoryAcpSessionStore | SqliteAcpSessionStore,
    sessionIdentity: "assigned" | "native" = "assigned",
): AgentRuntimeManager {
    return new AgentRuntimeManager({
        observer: new NullAcpSessionObserver(),
        store,
        adapters: acpAdapters,
        sessionIdentity,
        onSessionStatusChanged: () => undefined,
        contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
        timer: systemTimer,
        maxProcesses: null,
    });
}

describe("Session settings reads after a daemon restart", () => {
    it("Given a stored session, When an unknown session is read, Then the lookup reports it missing", async () => {
        const manager = createManager(new MemoryAcpSessionStore());
        try {
            expect(manager.findSessions(["missing-session"])).toHaveLength(0);
        } finally {
            await manager.close();
        }
    });

    it("Given an Agent without history loading, When its stored session's settings are read through the config-read path, Then the read resolves with the current configuration", async () => {
        const sessionId = "no-load-config-read-session";
        // The controlled peer advertises loadSession: false with this flag, so
        // any history-required preparation would fail with
        // native_history_unsupported before reaching the configuration.
        const { agent } = await controlledAgent("controlled-config-read", ["--no-load-session"]);
        const store = new MemoryAcpSessionStore();
        const manager = createManager(store);
        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "no-load-config-read-command",
                cwd: process.cwd(),
                images: [],
                resources: [],
                sessionId,
                prompt: "Complete this turn",
                signal: AbortSignal.timeout(10_000),
            });
        } finally {
            // Retiring the process leaves the stored row; the read must still
            // work without ever loading history.
            await manager.close();
        }

        const reader = createManager(store);
        try {
            const [found] = reader.findSessions([sessionId]);
            expect(found?.sessionId).toBe(sessionId);
            // The history-required path the read must not use: without load
            // support it fails before any configuration is reachable.
            await expect(
                reader.restoreSession({
                    additionalDirectories: [],
                    agent,
                    cwd: process.cwd(),
                    sessionId,
                    signal: AbortSignal.timeout(10_000),
                }),
            ).rejects.toMatchObject({ code: "native_history_unsupported" });
            const prepared = await reader.prepareSession({
                additionalDirectories: [],
                agent,
                cwd: process.cwd(),
                sessionId,
                signal: AbortSignal.timeout(10_000),
            });
            const model = prepared.configOptions.find((option) => option.id === "model");
            if (model?.type !== "select") {
                throw new Error("Expected the fake peer to report a model select option");
            }
            expect(model.currentValue).toBe("test-small");
        } finally {
            await reader.close();
        }
    });

    it("Given a native chat session was retired, When it is looked up before a reload, Then the lookup reports it missing and a reload restores its configured settings", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-session-config-read-retired-"));
        const databasePath = join(temporaryDirectory, "sessions.sqlite");
        // Native chat session ids are the Agent's own UUIDs for codex/claude/pi;
        // the mobius session id doubles as the native id for imported sessions.
        const sessionId = crypto.randomUUID();
        const { agent, stateDirectory } = await controlledAgent("claude");
        await seedPeerSession(stateDirectory, sessionId);
        const store = new SqliteAcpSessionStore(openAcpSessionDatabase(databasePath));
        const first = createManager(store, "native");
        try {
            const imported = await first.openNativeSession(
                {
                    additionalDirectories: [],
                    agent,
                    cwd: process.cwd(),
                    sessionId,
                    signal: AbortSignal.timeout(10_000),
                },
                { kind: "import", nativeSessionId: sessionId, title: "Imported native session" },
            );
            expect(imported.sessionId).toBe(sessionId);
            await first.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "config-read-retired-command",
                cwd: process.cwd(),
                images: [],
                resources: [],
                sessionId,
                prompt: "Complete this turn",
                signal: AbortSignal.timeout(10_000),
            });
            // Configure a model so a later read has a non-default value to find.
            await first.configureSession({
                additionalDirectories: [],
                agent,
                booleanValue: false,
                configId: "model",
                cwd: process.cwd(),
                requestId: "config-read-retired-configure",
                sessionId,
                signal: AbortSignal.timeout(10_000),
                value: "test-large",
                valueType: "select",
            });
        } finally {
            await first.close();
        }
        // Retiring an imported native chat session deletes its row: the Agent
        // owns the conversation, so a client that still wants it must reload
        // (re-import) first — the same contract session.restore exposes.
        expect(store.read(sessionId)).toBeInstanceOf(MissingAcpStoredSession);
        expect(createManager(store, "native").findSessions([sessionId])).toHaveLength(0);

        // After the client reloads the conversation, the settings read finds
        // the session again and reports the Agent's configured model.
        const restarted = createManager(store, "native");
        try {
            const reloaded = await restarted.openNativeSession(
                {
                    additionalDirectories: [],
                    agent,
                    cwd: process.cwd(),
                    sessionId,
                    signal: AbortSignal.timeout(10_000),
                },
                { kind: "import", nativeSessionId: sessionId, title: "Imported native session" },
            );
            expect(reloaded.sessionId).toBe(sessionId);
            const [found] = restarted.findSessions([sessionId]);
            expect(found?.sessionId).toBe(sessionId);
            const prepared = await restarted.prepareSession({
                additionalDirectories: [],
                agent,
                cwd: process.cwd(),
                sessionId,
                signal: AbortSignal.timeout(10_000),
            });
            const model = prepared.configOptions.find((option) => option.id === "model");
            if (model?.type !== "select") {
                throw new Error("Expected the fake peer to report a model select option");
            }
            expect(model.currentValue).toBe("test-large");
        } finally {
            await restarted.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });
});
