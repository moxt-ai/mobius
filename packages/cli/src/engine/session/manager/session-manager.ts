import {
    SESSION_CLOSE_NOTICE_KIND,
    SESSION_CLOSED_ERROR_CODE,
    type SessionCapabilities,
    type SessionCloseNoticeEvent,
    type SessionEventPayload,
    type SessionStatus,
    type SessionStatusChangedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { NativeSessionOrigin } from "../../acp/protocol/native-session.ts";
import { unsupportedSessionCapabilities } from "../../acp/protocol/session-capabilities.ts";
import { type OperationMetrics, unmeasuredOperationMetrics } from "../../infra/operation-metrics.ts";
import type { Timer } from "../../util/timer.ts";
import { AgentSession } from "../live/agent-session.ts";
import { isNativeChatSessionId } from "../native/native-chat-agent.ts";
import { nativeSessionQuery } from "../native/native-query.ts";
import type { AgentProcessPool, AgentProcessRetention } from "../process/agent-process-pool.ts";
import { RetainedAgentProcesses } from "../process/retained-agent-processes.ts";
import {
    FoundStoredSession,
    MemorySessionStore,
    MissingStoredSession,
    type SessionStore,
} from "../record/session-store.ts";
import { ActiveExecutions } from "../turn/active-executions.ts";
import { RuntimeOperations, waitForSharedOperation } from "./operation-drain.ts";

const SESSION_CONTROL_TIMEOUT_MILLISECONDS = 30_000;
const SESSION_CLOSE_TIMEOUT_MILLISECONDS = 30_000;

/** What preparing does with a closed Session: a prepare or restore reopens it, a read must keep it closed. */
export type ClosedSessionHandling = "reopen" | "keep-closed";

import {
    type AgentSettingsInspectionOptions,
    AgentSettingsSnapshot,
    type ElicitationResponseOptions,
    NullSessionObserver,
    type PermissionResponseOptions,
    type PreparedSession,
    type PromptResult,
    type ResolveAgent,
    type SessionConfigurationSnapshot,
    type SessionConfigureOptions,
    type SessionObserver,
    type SessionPrepareOptions,
    type SessionRecovery,
    type SessionSteerOptions,
    type SessionTurnOptions,
} from "../api/session-api.ts";
import type { SessionEventPage } from "../history/session-event-store.ts";

/** Identifies a native session while an import, fork, or continuation manages it. */
const nativeOperationKey = (agentId: string, nativeSessionId: string): string => `${agentId}:${nativeSessionId}`;

export class SessionManager {
    readonly #operations = new RuntimeOperations();
    readonly #processes: AgentProcessPool;
    readonly #executionProcesses = new RetainedAgentProcesses<AgentSession>({
        touch: (runtime) => this.#processes.touch(runtime),
        changed: () => this.#processes.notifyChanged(),
    });
    readonly #executions = new ActiveExecutions();
    readonly #agentSettingsObserver = new NullSessionObserver();
    readonly #nativeOperations = new Set<string>();
    readonly #sessionClosures = new Map<string, Promise<void>>();
    readonly #sessionRetirements = new Map<string, Promise<void>>();
    /** Sessions that were closed and not reopened since. Only a prepare or restore of the Session reopens it. */
    readonly #closedSessions = new Set<string>();
    readonly #store: SessionStore;
    readonly #sessionIdentity: "assigned" | "native";
    readonly #onSessionStatusChanged: (event: SessionStatusChangedEvent) => void;
    readonly #onSessionClosed: (event: SessionCloseNoticeEvent) => void;
    readonly #timer: Timer;
    #observer: SessionObserver;

    constructor({
        observer,
        store,
        processes,
        sessionIdentity,
        onSessionStatusChanged,
        onSessionClosed = () => undefined,
        timer,
    }: {
        readonly observer: SessionObserver;
        readonly store: SessionStore;
        readonly processes: AgentProcessPool;
        readonly sessionIdentity: "assigned" | "native";
        readonly onSessionStatusChanged: (event: SessionStatusChangedEvent) => void;
        /** Called once each time a Session becomes closed, so every client learns of it. */
        readonly onSessionClosed?: (event: SessionCloseNoticeEvent) => void;
        readonly timer: Timer;
    }) {
        this.#observer = observer;
        this.#processes = processes;
        this.#store = store;
        this.#sessionIdentity = sessionIdentity;
        this.#onSessionStatusChanged = onSessionStatusChanged;
        this.#onSessionClosed = onSessionClosed;
        this.#timer = timer;
    }

    readonly recordLifecycleEvent = async (sessionId: string, event: SessionEventPayload): Promise<boolean> => {
        const runtime = this.#executionProcesses.get(sessionId);
        if (runtime === undefined) {
            return false;
        }
        return await runtime.recordControlEvent(event);
    };

    readonly setObserver = (observer: SessionObserver): void => {
        this.#observer = observer;
    };

    #isNativeSessionOperationActive(sessionId: string): boolean {
        if (this.#nativeOperations.size === 0) {
            return false;
        }
        const stored = this.#store.read(sessionId);
        return (
            stored instanceof FoundStoredSession &&
            this.#nativeOperations.has(nativeOperationKey(stored.session.agentId, stored.session.nativeSessionId))
        );
    }

    #retention(sessionId: string): AgentProcessRetention<AgentSession> {
        return {
            isBusy: () =>
                this.#executionProcesses.get(sessionId)?.hasBackgroundActivity() === true ||
                this.#executions.isBusy(sessionId) ||
                this.#executionProcesses.isBusy(sessionId) ||
                this.#isNativeSessionOperationActive(sessionId),
            retire: (runtime) => this.#retireSessionProcess(sessionId, runtime, () => runtime.close()),
            retireIdle: (runtime) => this.#stopSessionProcess(sessionId, runtime),
        };
    }

    async #retireSessionProcess(sessionId: string, runtime: AgentSession, close: () => Promise<void>): Promise<void> {
        const retained = this.#executionProcesses.detach(sessionId, runtime);
        try {
            await this.#processes.retire(runtime, close);
        } finally {
            if (retained && this.#sessionIdentity === "native") {
                const stored = this.#store.read(sessionId);
                if (
                    stored instanceof FoundStoredSession &&
                    stored.session.nativeSessionId === sessionId &&
                    isNativeChatSessionId(stored.session.agentId, sessionId)
                ) {
                    this.#store.remove(sessionId);
                }
            }
        }
    }

    /**
     * Releases a closed or idle Session's process while keeping its title, settings and native
     * identity available for the next preparation. This does not mark the Session closed.
     */
    async #stopSessionProcess(sessionId: string, runtime: AgentSession): Promise<void> {
        this.#executionProcesses.detach(sessionId, runtime);
        const retirement = this.#processes.retire(runtime, () => runtime.close());
        this.#sessionRetirements.set(sessionId, retirement);
        try {
            await retirement;
        } finally {
            if (this.#sessionRetirements.get(sessionId) === retirement) {
                this.#sessionRetirements.delete(sessionId);
            }
        }
    }

    #isKnownSession(sessionId: string): boolean {
        return (
            this.#executionProcesses.get(sessionId) !== undefined ||
            this.#executionProcesses.pending(sessionId) !== undefined ||
            this.#store.read(sessionId) instanceof FoundStoredSession
        );
    }

    /**
     * Marks a Session closed and tells every client why, once for each closing. Clients show `reason` to their
     * users as is. Unknown Sessions have nothing to close.
     */
    #announceClosed(sessionId: string, reason: string): void {
        if (this.#closedSessions.has(sessionId) || !this.#isKnownSession(sessionId)) {
            return;
        }
        this.#closedSessions.add(sessionId);
        this.#onSessionClosed({ kind: SESSION_CLOSE_NOTICE_KIND, reason, sessionId });
    }

    /** A closed Session fails the operations that would silently reopen it, so a client learns that its view is stale. */
    #assertOpen(sessionId: string): void {
        if (this.#closedSessions.has(sessionId)) {
            throw new AcpExecutionError("The Session is closed; reopen it to continue", {}, SESSION_CLOSED_ERROR_CODE);
        }
    }

    async #startRetainedSessionProcess(
        options: SessionPrepareOptions,
        start: (capabilities: SessionCapabilities) => Promise<AgentSession>,
    ): Promise<AgentSession> {
        const retiring = this.#sessionRetirements.get(options.sessionId);
        if (retiring !== undefined) {
            // The old process may still own the native writer while graceful teardown runs.
            await waitForSharedOperation(retiring, options.signal);
        }
        const stored = this.#store.read(options.sessionId);
        // Discovery may acquire a pooled reader: do it before reserving execution capacity.
        const capabilities =
            options.origin !== undefined || (stored instanceof FoundStoredSession && stored.session.prompted)
                ? await options.adapter.getCapabilities(nativeSessionQuery(options))
                : unsupportedSessionCapabilities();
        const runtime = await this.#processes.startRetained(
            options.signal,
            () => start(capabilities),
            this.#retention(options.sessionId),
        );
        this.#executionProcesses.retain(options.sessionId, runtime);
        return runtime;
    }

    async #startPreparation(
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AgentSession> {
        return await this.#executionProcesses.prepare(options.sessionId, async () => {
            const effectiveOptions: SessionPrepareOptions =
                options.origin === undefined &&
                this.#sessionIdentity === "native" &&
                isNativeChatSessionId(options.agent.id, options.sessionId) &&
                this.#store.read(options.sessionId) instanceof MissingStoredSession
                    ? { ...options, origin: { kind: "import", nativeSessionId: options.sessionId, title: "" } }
                    : options;
            return await this.#startRetainedSessionProcess(
                effectiveOptions,
                async (capabilities) =>
                    await AgentSession.start(
                        effectiveOptions,
                        recovery,
                        () => this.#observer,
                        this.#store,
                        metrics,
                        options.adapter,
                        capabilities,
                    ),
            );
        });
    }

    async #replacePreparation(
        existing: AgentSession,
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        metrics: OperationMetrics,
    ): Promise<AgentSession> {
        return await this.#executionProcesses.prepare(options.sessionId, async () => {
            await this.#retireSessionProcess(
                options.sessionId,
                existing,
                async () => await metrics.measure("runtime-replacement-close", async () => await existing.close()),
            );
            this.#store.remove(options.sessionId);
            return await this.#startRetainedSessionProcess(
                options,
                async (capabilities) =>
                    await AgentSession.start(
                        options,
                        recovery,
                        () => this.#observer,
                        this.#store,
                        metrics,
                        options.adapter,
                        capabilities,
                    ),
            );
        });
    }

    async #replaceExecutionPreparation(existing: AgentSession, options: SessionPrepareOptions): Promise<AgentSession> {
        const desiredConfigOptions = existing.prepared().configOptions;
        const recovery: SessionRecovery = options.recovery ?? { kind: "interactive-only" };
        return await this.#executionProcesses.prepare(options.sessionId, async () => {
            await this.#retireSessionProcess(options.sessionId, existing, async () => await existing.close());
            const runtime = await this.#startRetainedSessionProcess(
                options,
                async (capabilities) =>
                    await AgentSession.start(
                        options,
                        recovery,
                        () => this.#observer,
                        this.#store,
                        unmeasuredOperationMetrics,
                        options.adapter,
                        capabilities,
                    ),
            );
            try {
                for (const desired of desiredConfigOptions) {
                    const current = runtime.prepared().configOptions.find((option) => option.id === desired.id);
                    if (current === undefined || current.type !== desired.type) {
                        continue;
                    }
                    if (desired.type === "boolean") {
                        if (current.booleanValue !== desired.booleanValue) {
                            await runtime.configure({
                                ...options,
                                booleanValue: desired.booleanValue,
                                configId: desired.id,
                                expectedConfigurationRevision: null,
                                requestId: `execution-prepare-${desired.id}`,
                                value: "",
                                valueType: "boolean",
                            });
                        }
                        continue;
                    }
                    if (
                        current.currentValue !== desired.currentValue &&
                        current.values.some((value) => value.value === desired.currentValue)
                    ) {
                        await runtime.configure({
                            ...options,
                            booleanValue: false,
                            configId: desired.id,
                            expectedConfigurationRevision: null,
                            requestId: `execution-prepare-${desired.id}`,
                            value: desired.currentValue,
                            valueType: "select",
                        });
                    }
                }
            } catch (error) {
                await this.#retireSessionProcess(options.sessionId, runtime, async () => await runtime.close());
                throw error;
            }
            return runtime;
        });
    }

    /**
     * Reuses an idle process only while it still continues the latest native conversation.
     * Otherwise its Agent would answer from, and append to, an earlier copy, so the process is
     * released and the Session reopens from native history as after idle reclamation.
     */
    async #currentSessionProcess(
        existing: AgentSession,
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
    ): Promise<AgentSession> {
        const changed =
            !this.#isNativeSessionOperationActive(options.sessionId) &&
            (await existing.nativeHistoryChanged(options.signal));
        // Another operation may have reopened the Session while the native history was read.
        const pending = this.#executionProcesses.pending(options.sessionId);
        if (pending !== undefined) {
            return await waitForSharedOperation(pending, options.signal);
        }
        const current = this.#executionProcesses.get(options.sessionId);
        if (current !== undefined && current !== existing) {
            return current;
        }
        if (!changed) {
            return existing;
        }
        return await this.#executionProcesses.prepare(options.sessionId, async () => {
            await this.#stopSessionProcess(options.sessionId, existing);
            return await this.#startRetainedSessionProcess(
                options,
                async (capabilities) =>
                    await AgentSession.start(
                        options,
                        recovery,
                        () => this.#observer,
                        this.#store,
                        unmeasuredOperationMetrics,
                        options.adapter,
                        capabilities,
                    ),
            );
        });
    }

    async #prepareSession(
        options: SessionPrepareOptions,
        recovery: SessionRecovery,
        closed: ClosedSessionHandling,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<PreparedSession> {
        return await this.#executionProcesses.use(options.sessionId, async () =>
            this.#operations.run(options, async (options) => {
                const closing = this.#sessionClosures.get(options.sessionId);
                if (closing !== undefined) {
                    await waitForSharedOperation(closing, options.signal);
                }
                if (closed === "reopen") {
                    // Preparing or restoring a Session is how a client reopens it.
                    this.#closedSessions.delete(options.sessionId);
                } else {
                    this.#assertOpen(options.sessionId);
                }
                if (
                    metrics.measureSync("session-state-read", () =>
                        this.#isNativeSessionOperationActive(options.sessionId),
                    )
                ) {
                    throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
                }
                const pending = this.#executionProcesses.pending(options.sessionId);
                if (pending !== undefined) {
                    const runtime = await metrics.measure(
                        "session-preparation-wait",
                        async () => await waitForSharedOperation(pending, options.signal),
                    );
                    if (runtime.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                        this.#executionProcesses.touch(options.sessionId, runtime);
                        if (recovery.kind === "history-required") {
                            await metrics.measure(
                                "session-load",
                                async () => await runtime.ensureHistoryLoaded(options.signal),
                            );
                        }
                        return runtime.prepared();
                    }
                    return await this.#prepareSession(options, recovery, closed, metrics);
                }
                const existing = this.#executionProcesses.get(options.sessionId);
                if (existing !== undefined) {
                    if (existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                        const runtime = await this.#currentSessionProcess(existing, options, recovery);
                        this.#executionProcesses.touch(options.sessionId, runtime);
                        if (recovery.kind === "history-required") {
                            await metrics.measure(
                                "session-load",
                                async () => await runtime.ensureHistoryLoaded(options.signal),
                            );
                        }
                        return runtime.prepared();
                    }
                    if (!existing.canRebind()) {
                        throw new AcpExecutionError(
                            "The agent or workspace cannot change after a conversation has started",
                            {},
                            "session_identity_mismatch",
                        );
                    }
                    const runtime = await this.#replacePreparation(existing, options, recovery, metrics);
                    return runtime.prepared();
                }
                const runtime = await this.#startPreparation(options, recovery, metrics);
                return runtime.prepared();
            }),
        );
    }

    readonly prepareSession = async (
        options: SessionPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
        closed: ClosedSessionHandling = "reopen",
    ): Promise<PreparedSession> => await this.#prepareSession(options, { kind: "interactive-only" }, closed, metrics);

    readonly restoreSession = async (
        options: SessionPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
        closed: ClosedSessionHandling = "reopen",
    ): Promise<PreparedSession> => await this.#prepareSession(options, { kind: "history-required" }, closed, metrics);

    /**
     * Opens a short-lived native ACP session only to read the local Agent's
     * authoritative settings. Its identity and store are private to this
     * operation and never become a Mobius Session.
     */
    readonly inspectAgentSettings = async (options: AgentSettingsInspectionOptions): Promise<AgentSettingsSnapshot> =>
        this.#operations.run(options, async (options) => {
            return await this.#processes.runTransient(
                options.signal,
                async () =>
                    await AgentSession.start(
                        {
                            ...options,
                            sessionId: `agent-settings-${crypto.randomUUID()}`,
                        },
                        { kind: "interactive-only" },
                        () => this.#agentSettingsObserver,
                        new MemorySessionStore(),
                        unmeasuredOperationMetrics,
                        options.adapter,
                    ),
                async (runtime) => {
                    const prepared = runtime.prepared();
                    const discoveredModelEffort = runtime.agentSettingsModelEffort();
                    const model = options.model;
                    const modelOption = prepared.configOptions.find(
                        (option) => option.id === "model" || option.category === "model",
                    );
                    // A Session cannot switch a model select with a single value, and the
                    // Agent already reported its settings for that current model.
                    const modelIsFixed =
                        modelOption?.type === "select" &&
                        modelOption.values.length < 2 &&
                        modelOption.currentValue === model;
                    const configOptions =
                        model === undefined || modelIsFixed
                            ? prepared.configOptions
                            : (
                                  await runtime.configure({
                                      ...options,
                                      booleanValue: false,
                                      configId: modelOption?.id ?? "model",
                                      expectedConfigurationRevision: null,
                                      requestId: "agent-settings-model",
                                      sessionId: `agent-settings-${crypto.randomUUID()}`,
                                      value: model,
                                      valueType: "select",
                                  })
                              ).configOptions;
                    return new AgentSettingsSnapshot(
                        prepared.agentName,
                        prepared.agentVersion,
                        configOptions,
                        discoveredModelEffort === null
                            ? { kind: "unavailable" }
                            : { kind: "complete", value: discoveredModelEffort },
                    );
                },
                async (runtime) => await runtime.close(),
            );
        });

    /**
     * Retained for Agents that expose a separate persisted configuration channel.
     * Use inspectAgentSettings for Agent-scoped settings discovery.
     */
    readonly inspectSession = async (
        options: SessionPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<PreparedSession> =>
        this.#operations.run(options, async (options) => {
            if (
                this.#executionProcesses.pending(options.sessionId) !== undefined ||
                this.#executionProcesses.get(options.sessionId) !== undefined
            ) {
                throw new AcpExecutionError(
                    "The configuration inspection session is already in use",
                    {},
                    "session_busy",
                );
            }
            return await this.#executionProcesses.use(options.sessionId, async () => {
                const runtime = await this.#startPreparation(options, { kind: "interactive-only" }, metrics);
                try {
                    return runtime.prepared();
                } finally {
                    try {
                        await this.#retireSessionProcess(options.sessionId, runtime, async () => await runtime.close());
                    } finally {
                        this.#store.remove(options.sessionId);
                    }
                }
            });
        });

    readonly prepareExecutionSession = async (options: SessionPrepareOptions): Promise<PreparedSession> =>
        this.#operations.run(options, async (options) => {
            const recovery: SessionRecovery = options.recovery ?? { kind: "interactive-only" };
            this.#assertOpen(options.sessionId);
            const pending = this.#executionProcesses.pending(options.sessionId);
            if (pending !== undefined) {
                await waitForSharedOperation(pending, options.signal);
                return await this.prepareExecutionSession(options);
            }
            const existing = this.#executionProcesses.get(options.sessionId);
            if (existing === undefined) {
                return (await this.#startPreparation(options, recovery)).prepared();
            }
            if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            if (existing.usesEnvironment(options.agent.environment)) {
                const runtime = await this.#currentSessionProcess(existing, options, recovery);
                if (recovery.kind === "execution-only") {
                    runtime.startExecutionOnlyCapture();
                }
                this.#executionProcesses.touch(options.sessionId, runtime);
                return runtime.prepared();
            }
            if (existing.hasRunningTurn()) {
                throw new AcpExecutionError(
                    "The execution environment cannot change while a conversation turn is running",
                    {},
                    "session_busy",
                );
            }
            return (await this.#replaceExecutionPreparation(existing, options)).prepared();
        });

    readonly configureSession = async (options: SessionConfigureOptions): Promise<SessionConfigurationSnapshot> =>
        this.#operations.run(options, async (options) => {
            return await this.#executionProcesses.use(options.sessionId, async () => {
                const runtime = await this.ensureSession(options);
                return await runtime.configure(options);
            });
        });

    readonly renameSession = async (
        options: SessionPrepareOptions,
        title: string,
    ): Promise<{ readonly title: string; readonly updatedAt: string }> =>
        await this.#executionProcesses.use(options.sessionId, async () =>
            this.#operations.run(options, async (options) => {
                this.#assertOpen(options.sessionId);
                // Process reclamation must not turn a native rename into a metadata-only write.
                // Keep the same process borrowed through recovery and the acknowledged rename.
                const existing = this.#executionProcesses.get(options.sessionId);
                if (existing === undefined) {
                    await this.#prepareSession(options, { kind: "interactive-only" }, "keep-closed");
                } else {
                    await this.#currentSessionProcess(existing, options, { kind: "interactive-only" });
                }
                const runtime = this.#executionProcesses.get(options.sessionId);
                if (runtime === undefined) {
                    throw new AcpExecutionError("ACP session did not start");
                }
                return await runtime.renameSession(title, options.signal);
            }),
        );

    readonly cancelPrompt = async (
        sessionId: string,
        signal: AbortSignal = AbortSignal.timeout(30_000),
    ): Promise<void> =>
        this.#operations.run({ signal }, async ({ signal }) => {
            await this.#executions.cancel(sessionId, async () => {
                const runtime = this.#executionProcesses.get(sessionId);
                if (runtime !== undefined) {
                    const outcome = await runtime.cancel(signal);
                    switch (outcome) {
                        case "retained":
                            break;
                        case "closed":
                            // Preserve the native conversation and effective settings for
                            // the next prompt, but never reuse a cancelled endpoint.
                            await this.#stopSessionProcess(sessionId, runtime);
                            break;
                        default: {
                            const unreachable: never = outcome;
                            throw new AcpExecutionError("Unexpected cancellation outcome", { cause: unreachable });
                        }
                    }
                }
            });
        });

    readonly steerPrompt = async (options: SessionSteerOptions): Promise<string> =>
        this.#operations.run(options, async (options) => {
            if (this.#executions.command(options.sessionId) !== options.targetCommandId) {
                throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
            }
            const pending = this.#executionProcesses.pending(options.sessionId);
            if (pending !== undefined) {
                await waitForSharedOperation(pending, options.signal);
            }
            if (this.#executions.command(options.sessionId) !== options.targetCommandId) {
                throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
            }
            const runtime = this.#executionProcesses.get(options.sessionId);
            if (
                runtime === undefined ||
                !runtime.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)
            ) {
                throw new AcpExecutionError(
                    "The target turn execution context is unavailable",
                    {},
                    "steering_target_unavailable",
                );
            }
            const deadlineController = new AbortController();
            const deadline = setTimeout(
                () =>
                    deadlineController.abort(
                        new AcpExecutionError("The steering request exceeded its deadline", {}, "steering_timeout"),
                    ),
                SESSION_CONTROL_TIMEOUT_MILLISECONDS,
            );
            deadline.unref();
            try {
                return await runtime.steer({
                    ...options,
                    signal: AbortSignal.any([options.signal, deadlineController.signal]),
                });
            } catch (error) {
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent steering failed", { cause: error }, "steering_failed");
            } finally {
                clearTimeout(deadline);
            }
        });

    readonly runPrompt = async (options: SessionTurnOptions): Promise<PromptResult> =>
        this.#operations.run(options, async (options) => {
            // A close can land after the prompt was prepared; fail before the Session is reported working.
            this.#assertOpen(options.sessionId);
            if (this.#isNativeSessionOperationActive(options.sessionId)) {
                throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
            }
            this.#executions.begin(options.sessionId, options.commandId);
            try {
                this.#onSessionStatusChanged({
                    kind: "session.status.changed",
                    sessionId: options.sessionId,
                    status: { commandId: options.commandId, kind: "working" },
                });
                if (this.#executions.cancellation(options.sessionId) !== undefined) {
                    return { stopReason: "cancelled" };
                }
                const runtime = await this.ensureSession(options);
                if (this.#nativeOperations.has(nativeOperationKey(options.agent.id, runtime.nativeSessionId()))) {
                    throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
                }
                if (this.#executions.cancellation(options.sessionId) !== undefined) {
                    return { stopReason: "cancelled" };
                }
                try {
                    const result = await runtime.prompt({
                        ...options,
                        cancellationRequested: () => this.#executions.cancellation(options.sessionId) !== undefined,
                    });
                    return this.#executions.cancellation(options.sessionId) !== undefined
                        ? { stopReason: "cancelled" }
                        : result;
                } catch (error) {
                    if (this.#executions.cancellation(options.sessionId) !== undefined) {
                        await this.#executions.cancellation(options.sessionId);
                        return { stopReason: "cancelled" };
                    }
                    throw error;
                }
            } catch (error) {
                const failedRuntime = this.#executionProcesses.get(options.sessionId);
                if (failedRuntime !== undefined) {
                    await this.#retireSessionProcess(
                        options.sessionId,
                        failedRuntime,
                        async () => await failedRuntime.close(),
                    );
                }
                if (this.#executions.cancellation(options.sessionId) !== undefined) {
                    return { stopReason: "cancelled" };
                }
                if (error instanceof AcpExecutionError) {
                    throw error;
                }
                throw new AcpExecutionError("ACP agent execution failed", {
                    cause: error,
                });
            } finally {
                try {
                    await this.#executions.cancellation(options.sessionId);
                } finally {
                    this.#executions.finish(options.sessionId, options.commandId);
                    this.#onSessionStatusChanged({
                        kind: "session.status.changed",
                        sessionId: options.sessionId,
                        status: { kind: "idle" },
                    });
                    this.#executionProcesses.touch(options.sessionId);
                    this.#processes.notifyChanged();
                }
            }
        });

    readonly respondPermission = async (options: PermissionResponseOptions): Promise<void> => {
        this.#assertOpen(options.sessionId);
        const runtime = this.#executionProcesses.get(options.sessionId);
        if (runtime === undefined) {
            throw new AcpExecutionError("The permission request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondPermission(options);
    };

    readonly respondElicitation = async (options: ElicitationResponseOptions): Promise<void> => {
        this.#assertOpen(options.sessionId);
        const runtime = this.#executionProcesses.get(options.sessionId);
        if (runtime === undefined) {
            throw new AcpExecutionError("The elicitation request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondElicitation(options);
    };

    readonly closeSession = async (sessionId: string, signal: AbortSignal): Promise<void> =>
        this.#operations.run({ sessionId, signal }, async (options) => {
            const existing = this.#sessionClosures.get(options.sessionId);
            if (existing !== undefined) {
                await waitForSharedOperation(existing, options.signal);
                return;
            }
            // Announce first: clients must learn of the closing while its process is still going down.
            this.#announceClosed(options.sessionId, "This Session was closed on request.");
            const release = (async (): Promise<void> => {
                const retiring = this.#sessionRetirements.get(options.sessionId);
                if (retiring !== undefined) {
                    await retiring;
                }
                const pending = this.#executionProcesses.pending(options.sessionId);
                const runtime = pending === undefined ? this.#executionProcesses.get(options.sessionId) : await pending;
                if (runtime !== undefined) {
                    await this.#stopSessionProcess(options.sessionId, runtime);
                }
            })();
            const deadline = Promise.withResolvers<void>();
            const timeout = this.#timer.schedule(
                () =>
                    deadline.reject(
                        new AcpExecutionError(
                            "The Session could not close before its deadline",
                            {},
                            "session_close_timeout",
                        ),
                    ),
                SESSION_CLOSE_TIMEOUT_MILLISECONDS,
            );
            const completion = Promise.race([release, deadline.promise]).finally(timeout.cancel);
            this.#sessionClosures.set(options.sessionId, completion);
            const releaseFinished = (): void => {
                if (this.#sessionClosures.get(options.sessionId) === completion) {
                    this.#sessionClosures.delete(options.sessionId);
                }
            };
            void release.then(releaseFinished, releaseFinished);
            await waitForSharedOperation(completion, options.signal);
        });

    readonly close = async (): Promise<void> => {
        const retiring = this.#processes.stopIdleReclamation();
        await this.#operations.close(async () => {
            await retiring;
            const sessions = [...this.#executionProcesses.entries()];
            await Promise.all([
                ...sessions.map(
                    async ([sessionId, runtime]) =>
                        await this.#retireSessionProcess(sessionId, runtime, async () => await runtime.close()),
                ),
                ...this.#sessionClosures.values(),
            ]);
        });
    };

    readonly findSessions = (sessionIds: readonly string[]) =>
        sessionIds.flatMap((sessionId) => {
            const stored = this.#store.read(sessionId);
            return stored instanceof FoundStoredSession ? [stored.session] : [];
        });

    readonly sessionStatus = (sessionId: string): SessionStatus => {
        const commandId = this.#executions.command(sessionId);
        return commandId === undefined ? { kind: "idle" } : { commandId, kind: "working" };
    };

    readonly listSessions = (limit: number) =>
        this.#store
            .list()
            .filter((session) => session.prompted)
            .slice(0, limit);

    readonly findLinkedSessions = (agentId: string, nativeSessionId: string) =>
        this.#store.findNative(agentId, nativeSessionId);

    readonly hasPreparedSession = (
        sessionId: string,
        agentId: string,
        cwd: string,
        additionalDirectories: readonly string[],
    ): boolean => this.#executionProcesses.get(sessionId)?.belongsTo(agentId, cwd, additionalDirectories) === true;

    readonly createNativeSession = async (options: SessionPrepareOptions): Promise<string> =>
        this.#operations.run(options, async (options) => {
            const temporarySessionId = `new-${crypto.randomUUID()}`;
            const temporaryOptions = { ...options, sessionId: temporarySessionId };
            return await this.#executionProcesses.use(temporarySessionId, async () => {
                try {
                    const runtime = await this.#startPreparation(temporaryOptions, { kind: "interactive-only" });
                    let adopted = false;
                    try {
                        const nativeSessionId = runtime.nativeSessionId();
                        if (
                            !isNativeChatSessionId(options.agent.id, nativeSessionId) ||
                            this.#executionProcesses.get(nativeSessionId) !== undefined ||
                            !(this.#store.read(nativeSessionId) instanceof MissingStoredSession)
                        ) {
                            throw new AcpExecutionError(
                                "The Agent returned an invalid new Session ID",
                                {},
                                "invalid_native_session_response",
                            );
                        }
                        runtime.adoptNativeSessionId(nativeSessionId);
                        this.#executionProcesses.detach(temporarySessionId, runtime);
                        this.#executionProcesses.retain(nativeSessionId, runtime);
                        this.#processes.retain(runtime, this.#retention(nativeSessionId));
                        adopted = true;
                        return nativeSessionId;
                    } finally {
                        if (!adopted) {
                            await this.#retireSessionProcess(
                                temporarySessionId,
                                runtime,
                                async () => await runtime.closeProcess(),
                            );
                        }
                    }
                } finally {
                    this.#store.remove(temporarySessionId);
                }
            });
        });

    readonly ensureSession = async (options: SessionPrepareOptions): Promise<AgentSession> =>
        this.#operations.run(options, async (options) => {
            this.#assertOpen(options.sessionId);
            const existing = this.#executionProcesses.get(options.sessionId);
            if (existing !== undefined) {
                if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                    throw new AcpExecutionError(
                        "The agent or workspace cannot change after a conversation has started",
                        {},
                        "session_identity_mismatch",
                    );
                }
                const runtime = await this.#currentSessionProcess(
                    existing,
                    options,
                    options.recovery ?? { kind: "interactive-only" },
                );
                if (options.recovery?.kind === "execution-only") {
                    runtime.startExecutionOnlyCapture();
                }
                this.#executionProcesses.touch(options.sessionId, runtime);
                return runtime;
            }
            await this.#prepareSession(options, options.recovery ?? { kind: "interactive-only" }, "reopen");
            const started = this.#executionProcesses.get(options.sessionId);
            if (started === undefined) {
                throw new AcpExecutionError("ACP session did not start");
            }
            return started;
        });

    /** Coordinates native-reader conflicts without owning the harness query. */
    readonly withNativeSessionOperation = async <Result>(
        options: SessionPrepareOptions,
        nativeSessionId: string,
        operation: (options: SessionPrepareOptions) => Promise<Result>,
    ): Promise<Result> =>
        this.#operations.run(options, async (options) => {
            const key = nativeOperationKey(options.agent.id, nativeSessionId);
            if (this.#nativeOperations.has(key)) {
                throw new AcpExecutionError(
                    "Wait for the native session's running operation to finish",
                    {},
                    "session_busy",
                );
            }
            this.#nativeOperations.add(key);
            this.#processes.notifyChanged();
            try {
                return await operation(options);
            } finally {
                this.#nativeOperations.delete(key);
                this.#processes.notifyChanged();
            }
        });

    readonly loadSessionEvents = async (
        options: SessionPrepareOptions,
        eventLimit: number,
        cursor: string | null,
    ): Promise<SessionEventPage> =>
        this.#operations.run(options, async (options) => {
            return await this.#executionProcesses.use(options.sessionId, async () => {
                const runtime = await this.ensureSession(options);
                return await runtime.loadHistoryEvents(eventLimit, cursor, options.signal);
            });
        });

    async #nativeTargetOptions(
        options: SessionPrepareOptions,
        sessionId: string,
        resolveAgent: ResolveAgent,
    ): Promise<SessionPrepareOptions> {
        const resolved = await resolveAgent(options.agent.id, options.signal, sessionId);
        options.signal.throwIfAborted();
        return { ...options, ...resolved, sessionId };
    }

    readonly openNativeSession = async (
        options: SessionPrepareOptions,
        origin: NativeSessionOrigin,
        resolveAgent: ResolveAgent,
    ): Promise<{
        readonly sessionId: string;
        readonly prepared: PreparedSession;
    }> =>
        this.#operations.run(options, async (options) => {
            const key = nativeOperationKey(options.agent.id, origin.nativeSessionId);
            if (this.#nativeOperations.has(key)) {
                throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
            }
            const linked = this.#store.findNative(options.agent.id, origin.nativeSessionId);
            const existing = linked[0];
            if (origin.kind === "import" && existing !== undefined) {
                return await this.#executionProcesses.use(existing.sessionId, async () => {
                    // Importing a Session the Runtime already tracks opens it again, even when it was closed. A running
                    // turn does not prevent that: another device joins the same Session and sees the turn's progress.
                    this.#closedSessions.delete(existing.sessionId);
                    const target = await this.#nativeTargetOptions(options, existing.sessionId, resolveAgent);
                    const runtime = await this.ensureSession(target);
                    if (this.#nativeOperations.has(key)) {
                        throw new AcpExecutionError(
                            "Wait for the native session's running operation to finish",
                            {},
                            "session_busy",
                        );
                    }
                    this.#nativeOperations.add(key);
                    try {
                        return {
                            prepared: runtime.prepared(),
                            sessionId: existing.sessionId,
                        };
                    } finally {
                        this.#nativeOperations.delete(key);
                        this.#processes.notifyChanged();
                    }
                });
            }
            // A fork or a first import reads the native session, which a running turn may still be writing.
            if (
                linked.some(
                    (entry) =>
                        this.#executions.command(entry.sessionId) !== undefined ||
                        this.#executionProcesses.pending(entry.sessionId) !== undefined,
                )
            ) {
                throw new AcpExecutionError(
                    "Wait for the native session's running operation to finish",
                    {},
                    "session_busy",
                );
            }
            const target = await this.#nativeTargetOptions(options, options.sessionId, resolveAgent);
            if (
                this.#executionProcesses.get(options.sessionId) !== undefined ||
                this.#executionProcesses.pending(options.sessionId) !== undefined ||
                this.#store.read(options.sessionId) instanceof FoundStoredSession
            ) {
                throw new AcpExecutionError(
                    "The destination conversation already exists",
                    {},
                    "session_identity_mismatch",
                );
            }
            return await this.#executionProcesses.use(options.sessionId, async () => {
                this.#nativeOperations.add(key);
                try {
                    const runtime = await this.#startPreparation({ ...target, origin }, { kind: "interactive-only" });
                    const openedKey = nativeOperationKey(options.agent.id, runtime.nativeSessionId());
                    this.#nativeOperations.add(openedKey);
                    try {
                        const prepared = runtime.prepared();
                        return {
                            sessionId: options.sessionId,
                            prepared,
                        };
                    } finally {
                        this.#nativeOperations.delete(openedKey);
                        this.#processes.notifyChanged();
                    }
                } catch (error) {
                    this.#store.remove(options.sessionId);
                    const runtime = this.#executionProcesses.get(options.sessionId);
                    if (runtime !== undefined) {
                        await this.#retireSessionProcess(
                            options.sessionId,
                            runtime,
                            async () => await runtime.closeProcess(),
                        );
                    }
                    throw error;
                } finally {
                    this.#nativeOperations.delete(key);
                }
            });
        });
}
