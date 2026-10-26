import { methods } from "@agentclientprotocol/sdk";
import { SessionHistoryPolicy } from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import { unmeasuredOperationMetrics } from "../../src/infra/operation-metrics.ts";
import type { AgentSessionRestore } from "../../src/session/live/agent-session-restore.ts";
import { restoreSession } from "../../src/session/live/session-restore.ts";
import { executePrompt } from "../../src/session/prompt/execute-prompt.ts";
import { MemorySessionStore, StoredSession } from "../../src/session/record/session-store.ts";

function sessionFixture(options: { readonly resume: boolean }): {
    readonly calls: string[];
    readonly session: AgentSessionRestore;
} {
    const calls: string[] = [];
    const store = new MemorySessionStore();
    store.write(new StoredSession("session-1", "agent-1", "native-1", "/workspace", [], true, "Existing conversation"));
    let nativeSessionId = "native-1";
    const session = {
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
        sessionConfigProtocol: {
            normalizeLifecycle: () => [],
        },
        store,
        agentRequest: async (method: string) => {
            calls.push(method);
            if (method === methods.agent.session.resume && !options.resume) {
                throw new Error("resume is unsupported");
            }
            if (method === methods.agent.session.load) {
                throw new Error("execution-only must never load native history");
            }
            return {};
        },
        drained: async () => undefined,
        initializeAgent: async () => undefined,
        loadSession: async () => {
            calls.push(methods.agent.session.load);
            throw new Error("execution-only must never load native history");
        },
        nativeSessionId: () => nativeSessionId,
        race: async <T>(operation: Promise<T>) => await operation,
        restoreStoredConfigurations: async () => undefined,
        selectNativeSession: (sessionId: string) => {
            nativeSessionId = sessionId;
        },
        restrictSessionCapabilities: () => undefined,
        setConfigOptions: () => undefined,
        setNativeHistoryOwnership: () => undefined,
        setPrompted: () => undefined,
        setRestored: () => undefined,
        setSessionTitle: () => undefined,
        startExecutionOnlyCapture: () => calls.push("execution-only-capture"),
        writeStoredSession: () => undefined,
    } as unknown as AgentSessionRestore;
    return { calls, session };
}

test("execution-only recovery resumes an existing native session without loading history", async () => {
    const fixture = sessionFixture({ resume: true });

    await restoreSession(fixture.session, new AbortController().signal, { kind: "execution-only" });

    expect(fixture.calls).toEqual([methods.agent.session.resume, "execution-only-capture"]);
    expect(fixture.calls).not.toContain(methods.agent.session.load);
});

test("execution-only recovery fails closed when the native Agent cannot resume", async () => {
    const fixture = sessionFixture({ resume: false });

    await expect(
        restoreSession(fixture.session, new AbortController().signal, { kind: "execution-only" }),
    ).rejects.toMatchObject({ code: "execution_only_unsupported" });
    expect(fixture.calls).not.toContain(methods.agent.session.load);
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
        images: [],
        kind: "session.prompt" as const,
        prompt: "continue",
        resources: [],
        sessionId: "session-1",
        targetCommandId: "",
    };

    await executePrompt({
        operations: { transitionExecution: () => undefined },
        eventProjection: {
            completed: async () => undefined,
            failed: async () => undefined,
            started: () => ({}),
        },
        command,
        resolveAgent: async () => ({ id: "agent-1", environment: {} }),
        downloadArtifact: async () => new Uint8Array(),
        reportFailure: () => undefined,
        directories: { resolve: async () => "/workspace" },
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
