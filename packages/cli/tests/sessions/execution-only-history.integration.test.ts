import { SessionHistoryPolicy } from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { unmeasuredOperationMetrics } from "../../src/engine/infra/operation-metrics.ts";
import type { AgentSessionRestore } from "../../src/engine/session/live/agent-session-restore.ts";
import { restoreSession } from "../../src/engine/session/live/session-restore.ts";
import { executePrompt } from "../../src/engine/session/prompt/execute-prompt.ts";
import { MemorySessionStore, StoredSession } from "../../src/engine/session/record/session-store.ts";

function sessionFixture(options: { readonly resume: boolean }): {
    readonly calls: string[];
    readonly session: AgentSessionRestore;
} {
    const calls: string[] = [];
    const store = new MemorySessionStore();
    store.write(new StoredSession("session-1", "agent-1", "native-1", "/workspace", [], true, "Existing conversation"));
    let nativeSessionId = "native-1";
    const session: AgentSessionRestore = {
        additionalDirectories: [],
        agentId: "agent-1",
        capabilities: {
            additionalDirectories: false,
            audioPrompt: false,
            closeSession: false,
            deleteSession: false,
            embeddedContextPrompt: false,
            imagePrompt: false,
            listSessions: false,
            loadSession: true,
            promptQueueing: false,
            renameSession: false,
            resumeSession: options.resume,
            steering: false,
            unstableForkSession: false,
        },
        cwd: "/workspace",
        metrics: unmeasuredOperationMetrics,
        restored: false,
        sessionId: "session-1",
        store,
        createSession: async () => {
            throw new Error("execution-only must not create a session");
        },
        forkSession: async () => {
            throw new Error("execution-only must not fork a session");
        },
        openSession: async () => {
            calls.push("openSession");
            if (!options.resume) {
                throw new Error("resume is unsupported");
            }
            return {
                nativeSessionId,
                capabilities: session.capabilities,
                configOptions: [],
                agentName: "Controlled Agent",
                agentVersion: "1",
                agentSettingsModelEffort: null,
            };
        },
        openSessionWithReplay: async () => {
            calls.push("openSessionWithReplay");
            throw new Error("execution-only must never load native history");
        },
        nativeSessionId: () => nativeSessionId,
        restoreStoredConfigurations: async () => undefined,
        selectNativeSession: (sessionId: string) => {
            nativeSessionId = sessionId;
        },
        applySessionOpened: () => undefined,
        setConfigOptions: () => undefined,
        setNativeHistoryOwnership: () => undefined,
        setPrompted: () => undefined,
        setRestored: () => undefined,
        setSessionTitle: () => undefined,
        startExecutionOnlyCapture: () => calls.push("execution-only-capture"),
        writeStoredSession: () => undefined,
    };
    return { calls, session };
}

test("execution-only recovery resumes an existing native session without loading history", async () => {
    const fixture = sessionFixture({ resume: true });

    await restoreSession(fixture.session, new AbortController().signal, { kind: "execution-only" });

    expect(fixture.calls).toEqual(["openSession", "execution-only-capture"]);
    expect(fixture.calls).not.toContain("openSessionWithReplay");
});

test("execution-only recovery fails closed when the native Agent cannot resume", async () => {
    const fixture = sessionFixture({ resume: false });

    await expect(
        restoreSession(fixture.session, new AbortController().signal, { kind: "execution-only" }),
    ).rejects.toMatchObject({ code: "execution_only_unsupported" });
    expect(fixture.calls).not.toContain("openSessionWithReplay");
    expect(fixture.calls).not.toContain("execution-only-capture");
});

test("execution-only prompt propagation keeps the run path out of eager recovery", async () => {
    let runOptions: Record<string, unknown> | undefined;
    const command = {
        additionalDirectoryIds: [],
        agentId: "agent-1",
        bindingId: "binding-1",
        commandId: "command-1",
        directoryId: "default",
        disposition: "reject",
        historyPolicy: SessionHistoryPolicy.ExecutionOnly,
        attachments: [],
        kind: "session.prompt" as const,
        prompt: "continue",
        sessionId: "session-1",
        targetCommandId: "",
    };

    await executePrompt({
        operations: { markExecutionStarted: () => undefined },
        eventProjection: {
            completed: async () => undefined,
            failed: async () => undefined,
            started: () => ({}),
        },
        command,
        resolveAgent: async () => ({ id: "agent-1", environment: {} }),
        downloadArtifact: async () => new Uint8Array(),
        reportFailure: () => undefined,
        directories: {
            describe: async () => ({ label: "workspace", path: "/workspace" }),
            resolve: async () => "/workspace",
        },
        sessions: {
            prepareExecutionSession: async () => ({ configOptions: [] }),
            runPrompt: async (options: Record<string, unknown>) => {
                runOptions = options;
                return { stopReason: "end_turn" };
            },
        },
        attemptId: "attempt-1",
        activateAttempt: () => ({ epoch: "epoch-1", sequence: 0 }),
        waitForSessionAvailability: async () => ({ kind: "available", disposition: "reject" }),
        signal: new AbortController().signal,
        recordSteeringPrompt: () => false,
        cancellationRequested: () => false,
    } as never);

    expect(runOptions?.["recovery"]).toEqual({ kind: "execution-only" });
});
