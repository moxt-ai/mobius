import { ActiveExecutions } from "./active-executions.ts";
import { AgentQueryProcesses } from "./agent-query-processes.ts";
import { AgentSession } from "./agent-session.ts";
import { RetainedAgentProcesses } from "./retained-agent-processes.ts";
import { RuntimeOperations, waitForSharedOperation } from "./runtime-operations.ts";

export { createWritableAcpStream } from "./agent-connection.ts";

import type {
    SessionConfigOption,
    SessionEventPayload,
    SessionStatus,
    SessionStatusChangedEvent,
} from "@moxt-ai/mobius-sdk/protocol";
import { type OperationMetrics, unmeasuredOperationMetrics } from "../infra/operation-metrics.ts";
import { isNativeChatSessionId } from "../runtime/native-sessions/chat-agent.ts";
import type { Timer } from "../runtime/relay/timer.ts";
import { AcpExecutionError } from "./acp-error.ts";
import { AgentProcessPool, type AgentProcessRetention } from "./agent-process-pool.ts";
import type { AcpContentExternalizer } from "./external-content/acp-content-externalizer.ts";
import type { NativeSessionOrigin, NativeSessionPage } from "./native-session.ts";
import {
    type AcpSessionStore,
    AcpStoredSession,
    FoundAcpStoredSession,
    MemoryAcpSessionStore,
    MissingAcpStoredSession,
} from "./session-store.ts";

const SESSION_CONTROL_TIMEOUT_MILLISECONDS = 30_000;
const SESSION_CLOSE_TIMEOUT_MILLISECONDS = 30_000;

export { AcpConfigurationValueUnavailableError, AcpExecutionError } from "./acp-error.ts";
export type { Adapter } from "./adapter/context.ts";
export { type AdapterResolver, acpAdapters } from "./adapter/registry.ts";
export {
    type AcpAgentSettingsInspectionOptions,
    type AcpAgentSettingsModelEffort,
    AcpAgentSettingsSnapshot,
    type AcpConfigureOptions,
    type AcpElicitationResponseOptions,
    type AcpNativeEventReplay,
    type AcpPermissionResponseOptions,
    AcpPreparedSession,
    type AcpPrepareOptions,
    type AcpPromptResult,
    type AcpSessionObserver,
    type AcpSessionRecovery,
    type AcpSteerOptions,
    type AcpTurnOptions,
    NullAcpSessionObserver,
} from "./session-contracts.ts";

import type { AdapterContext, AdapterResolver, NativeSessionPreviewRequest } from "./adapter/context.ts";
import {
    type AcpAgentSettingsInspectionOptions,
    AcpAgentSettingsSnapshot,
    type AcpConfigureOptions,
    type AcpElicitationResponseOptions,
    type AcpNativeEventReplay,
    type AcpPermissionResponseOptions,
    type AcpPreparedSession,
    type AcpPrepareOptions,
    type AcpPromptResult,
    type AcpSessionObserver,
    type AcpSessionRecovery,
    type AcpSteerOptions,
    type AcpTurnOptions,
    NullAcpSessionObserver,
} from "./session-contracts.ts";

export class AgentRuntimeManager {
    readonly #operations = new RuntimeOperations();
    readonly #processes: AgentProcessPool;
    readonly #executionProcesses = new RetainedAgentProcesses({
        touch: (runtime) => this.#processes.touch(runtime),
        changed: () => this.#processes.notifyChanged(),
    });
    readonly #queryProcesses: AgentQueryProcesses;
    readonly #executions = new ActiveExecutions();
    readonly #agentSettingsObserver = new NullAcpSessionObserver();
    readonly #nativeOperations = new Set<string>();
    readonly #sessionClosures = new Map<string, Promise<void>>();
    readonly #store: AcpSessionStore;
    readonly #adapters: AdapterResolver;
    readonly #sessionIdentity: "assigned" | "native";
    readonly #onSessionStatusChanged: (event: SessionStatusChangedEvent) => void;
    readonly #contentExternalizer: AcpContentExternalizer;
    readonly #timer: Timer;
    #observer: AcpSessionObserver;

    constructor({
        observer,
        store,
        adapters,
        sessionIdentity,
        onSessionStatusChanged,
        contentExternalizer,
        timer,
        maxProcesses,
    }: {
        readonly observer: AcpSessionObserver;
        readonly store: AcpSessionStore;
        readonly adapters: AdapterResolver;
        readonly sessionIdentity: "assigned" | "native";
        readonly onSessionStatusChanged: (event: SessionStatusChangedEvent) => void;
        readonly contentExternalizer: AcpContentExternalizer;
        readonly timer: Timer;
        readonly maxProcesses: number | null;
    }) {
        this.#observer = observer;
        this.#processes = new AgentProcessPool(maxProcesses ?? undefined);
        this.#store = store;
        this.#adapters = adapters;
        this.#sessionIdentity = sessionIdentity;
        this.#onSessionStatusChanged = onSessionStatusChanged;
        this.#contentExternalizer = contentExternalizer;
        this.#timer = timer;
        this.#queryProcesses = new AgentQueryProcesses(this.#processes, contentExternalizer);
    }

    readonly recordLifecycleEvent = async (sessionId: string, event: SessionEventPayload): Promise<boolean> => {
        const runtime = this.#executionProcesses.get(sessionId);
        if (runtime === undefined) {
            return false;
        }
        return await runtime.recordControlEvent(event);
    };

    readonly setObserver = (observer: AcpSessionObserver): void => {
        this.#observer = observer;
    };

    #isNativeSessionOperationActive(sessionId: string): boolean {
        const stored = this.#store.read(sessionId);
        return (
            stored instanceof FoundAcpStoredSession &&
            this.#nativeOperations.has(`${stored.session.agentId}:${stored.session.nativeSessionId}`)
        );
    }

    #retention(sessionId: string): AgentProcessRetention {
        return {
            isBusy: () =>
                this.#executions.isBusy(sessionId) ||
                this.#executionProcesses.isBusy(sessionId) ||
                this.#isNativeSessionOperationActive(sessionId),
            retire: (runtime) => this.#retireSessionProcess(sessionId, runtime, () => runtime.close()),
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
                    stored instanceof FoundAcpStoredSession &&
                    stored.session.nativeSessionId === sessionId &&
                    isNativeChatSessionId(stored.session.agentId, sessionId)
                ) {
                    this.#store.remove(sessionId);
                }
            }
        }
    }

    async #startRetainedSessionProcess(
        options: AcpPrepareOptions,
        start: () => Promise<AgentSession>,
    ): Promise<AgentSession> {
        const runtime = await this.#processes.startRetained(options.signal, start, this.#retention(options.sessionId));
        this.#executionProcesses.retain(options.sessionId, runtime);
        return runtime;
    }

    async #startPreparation(
        options: AcpPrepareOptions,
        recovery: AcpSessionRecovery,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AgentSession> {
        return await this.#executionProcesses.prepare(options.sessionId, async () => {
            return await this.#startRetainedSessionProcess(
                options,
                async () =>
                    await AgentSession.start(
                        options.origin === undefined &&
                            this.#sessionIdentity === "native" &&
                            isNativeChatSessionId(options.agent.id, options.sessionId) &&
                            this.#store.read(options.sessionId) instanceof MissingAcpStoredSession
                            ? { ...options, origin: { kind: "import", nativeSessionId: options.sessionId, title: "" } }
                            : options,
                        recovery,
                        () => this.#observer,
                        this.#store,
                        metrics,
                        this.#contentExternalizer,
                    ),
            );
        });
    }

    async #replacePreparation(
        existing: AgentSession,
        options: AcpPrepareOptions,
        recovery: AcpSessionRecovery,
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
                async () =>
                    await AgentSession.start(
                        options,
                        recovery,
                        () => this.#observer,
                        this.#store,
                        metrics,
                        this.#contentExternalizer,
                    ),
            );
        });
    }

    async #replaceExecutionPreparation(existing: AgentSession, options: AcpPrepareOptions): Promise<AgentSession> {
        const desiredConfigOptions = existing.prepared().configOptions;
        return await this.#executionProcesses.prepare(options.sessionId, async () => {
            await this.#retireSessionProcess(options.sessionId, existing, async () => await existing.close());
            const runtime = await this.#startRetainedSessionProcess(
                options,
                async () =>
                    await AgentSession.start(
                        options,
                        { kind: "interactive-only" },
                        () => this.#observer,
                        this.#store,
                        unmeasuredOperationMetrics,
                        this.#contentExternalizer,
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

    async #prepareSession(
        options: AcpPrepareOptions,
        recovery: AcpSessionRecovery,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpPreparedSession> {
        return await this.#operations.run(options, async (options) => {
            const closing = this.#sessionClosures.get(options.sessionId);
            if (closing !== undefined) {
                await waitForSharedOperation(closing, options.signal);
            }
            const stored = metrics.measureSync("session-state-read", () => this.#store.read(options.sessionId));

            if (
                stored instanceof FoundAcpStoredSession &&
                this.#nativeOperations.has(`${stored.session.agentId}:${stored.session.nativeSessionId}`)
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
                return await this.#prepareSession(options, recovery, metrics);
            }
            const existing = this.#executionProcesses.get(options.sessionId);
            if (existing !== undefined) {
                if (existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                    this.#executionProcesses.touch(options.sessionId, existing);
                    if (recovery.kind === "history-required") {
                        await metrics.measure(
                            "session-load",
                            async () => await existing.ensureHistoryLoaded(options.signal),
                        );
                    }
                    return existing.prepared();
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
        });
    }

    readonly prepareSession = async (
        options: AcpPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpPreparedSession> => await this.#prepareSession(options, { kind: "interactive-only" }, metrics);

    readonly restoreSession = async (
        options: AcpPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpPreparedSession> => await this.#prepareSession(options, { kind: "history-required" }, metrics);

    /**
     * Opens a short-lived native ACP session only to read the local Agent's
     * authoritative settings. Its identity and store are private to this
     * operation and never become a Mobius Session.
     */
    readonly inspectAgentSettings = async (
        options: AcpAgentSettingsInspectionOptions,
    ): Promise<AcpAgentSettingsSnapshot> =>
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
                        new MemoryAcpSessionStore(),
                        unmeasuredOperationMetrics,
                        this.#contentExternalizer,
                    ),
                async (runtime) => {
                    const prepared = runtime.prepared();
                    const discoveredModelEffort = runtime.agentSettingsModelEffort();
                    const model = options.model;
                    const configOptions =
                        model === undefined
                            ? prepared.configOptions
                            : await runtime.configure({
                                  ...options,
                                  booleanValue: false,
                                  configId:
                                      prepared.configOptions.find(
                                          (option) => option.id === "model" || option.category === "model",
                                      )?.id ?? "model",
                                  requestId: "agent-settings-model",
                                  sessionId: `agent-settings-${crypto.randomUUID()}`,
                                  value: model,
                                  valueType: "select",
                              });
                    return new AcpAgentSettingsSnapshot(
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
        options: AcpPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpPreparedSession> =>
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

    readonly prepareExecutionSession = async (options: AcpPrepareOptions): Promise<AcpPreparedSession> =>
        this.#operations.run(options, async (options) => {
            const pending = this.#executionProcesses.pending(options.sessionId);
            if (pending !== undefined) {
                await waitForSharedOperation(pending, options.signal);
                return await this.prepareExecutionSession(options);
            }
            const existing = this.#executionProcesses.get(options.sessionId);
            if (existing === undefined) {
                return (await this.#startPreparation(options, { kind: "interactive-only" })).prepared();
            }
            if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            if (existing.usesEnvironment(options.agent.environment)) {
                this.#executionProcesses.touch(options.sessionId, existing);
                return existing.prepared();
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

    readonly prepareNativeSessionBrowser = (options: AcpPrepareOptions): Promise<AcpPreparedSession> =>
        this.#operations.run(options, (scoped) => this.#queryProcesses.prepare(scoped));

    readonly configureSession = async (options: AcpConfigureOptions): Promise<readonly SessionConfigOption[]> =>
        this.#operations.run(options, async (options) => {
            return await this.#executionProcesses.use(options.sessionId, async () => {
                const runtime = await this.ensureSession(options);
                return await runtime.configure(options);
            });
        });

    readonly renameSession = async (
        sessionId: string,
        title: string,
        signal: AbortSignal,
    ): Promise<{ readonly title: string; readonly updatedAt: string }> =>
        await this.#operations.run({ sessionId, signal }, async (options) => {
            const runtime = this.#executionProcesses.get(options.sessionId);
            if (runtime !== undefined) {
                return await runtime.renameSession(title, options.signal);
            }
            const stored = this.#store.read(options.sessionId);
            if (!(stored instanceof FoundAcpStoredSession)) {
                throw new AcpExecutionError("The Session was not found", {}, "session_not_found");
            }
            const normalized = title.slice(0, 500);
            const updatedAt = new Date().toISOString();
            this.#store.write(
                new AcpStoredSession(
                    stored.session.sessionId,
                    stored.session.agentId,
                    stored.session.nativeSessionId,
                    stored.session.cwd,
                    stored.session.additionalDirectories,
                    stored.session.prompted,
                    normalized,
                    updatedAt,
                    stored.session.configurations,
                ),
            );
            return { title: normalized, updatedAt };
        });

    readonly cancelPrompt = async (sessionId: string): Promise<void> => {
        await this.#executions.cancel(sessionId, async () => {
            const runtime = this.#executionProcesses.get(sessionId);
            if (runtime !== undefined) {
                await runtime.cancel();
            }
        });
    };

    readonly steerPrompt = async (options: AcpSteerOptions): Promise<string> =>
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

    readonly runPrompt = async (options: AcpTurnOptions): Promise<AcpPromptResult> =>
        this.#operations.run(options, async (options) => {
            const stored = this.#store.read(options.sessionId);
            if (
                stored instanceof FoundAcpStoredSession &&
                this.#nativeOperations.has(`${stored.session.agentId}:${stored.session.nativeSessionId}`)
            ) {
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
                if (this.#nativeOperations.has(`${options.agent.id}:${runtime.nativeSessionId()}`)) {
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

    readonly respondPermission = async (options: AcpPermissionResponseOptions): Promise<void> => {
        const runtime = this.#executionProcesses.get(options.sessionId);
        if (runtime === undefined) {
            throw new AcpExecutionError("The permission request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondPermission(options);
    };

    readonly respondElicitation = async (options: AcpElicitationResponseOptions): Promise<void> => {
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
            const release = (async (): Promise<void> => {
                const pending = this.#executionProcesses.pending(options.sessionId);
                const runtime = pending === undefined ? this.#executionProcesses.get(options.sessionId) : await pending;
                if (runtime !== undefined) {
                    await this.#retireSessionProcess(options.sessionId, runtime, async () => await runtime.close());
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

    readonly close = async (): Promise<void> =>
        this.#operations.close(async () => {
            const sessions = [...this.#executionProcesses.entries()];
            await Promise.all([
                ...sessions.map(
                    async ([sessionId, runtime]) =>
                        await this.#retireSessionProcess(sessionId, runtime, async () => await runtime.close()),
                ),
                ...this.#sessionClosures.values(),
                this.#queryProcesses.close(),
            ]);
        });

    readonly findSessions = (sessionIds: readonly string[]) =>
        sessionIds.flatMap((sessionId) => {
            const stored = this.#store.read(sessionId);
            return stored instanceof FoundAcpStoredSession ? [stored.session] : [];
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

    readonly createNativeSession = async (options: AcpPrepareOptions): Promise<string> =>
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
                            !(this.#store.read(nativeSessionId) instanceof MissingAcpStoredSession)
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

    readonly ensureSession = async (options: AcpPrepareOptions): Promise<AgentSession> =>
        this.#operations.run(options, async (options) => {
            const existing = this.#executionProcesses.get(options.sessionId);
            if (existing !== undefined) {
                if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                    throw new AcpExecutionError(
                        "The agent or workspace cannot change after a conversation has started",
                        {},
                        "session_identity_mismatch",
                    );
                }
                this.#executionProcesses.touch(options.sessionId, existing);
                return existing;
            }
            await this.prepareSession(options);
            const started = this.#executionProcesses.get(options.sessionId);
            if (started === undefined) {
                throw new AcpExecutionError("ACP session did not start");
            }
            return started;
        });

    readonly listNativeSessions = async (
        options: AcpPrepareOptions,
        cursor: string | null,
    ): Promise<NativeSessionPage> =>
        this.#operations.run(options, async (options) => {
            return await this.#queryProcesses.use(
                options,
                async (runtime) => await runtime.listNativeSessions(cursor, options.signal),
            );
        });

    readonly previewNativeSessionEvents = async (
        options: AcpPrepareOptions,
        nativeSessionId: string,
        eventLimit: number,
        cursor: string | null,
    ): Promise<AcpNativeEventReplay> =>
        this.#operations.run(options, async (options) => {
            const key = `${options.agent.id}:${nativeSessionId}`;
            if (this.#nativeOperations.has(key)) {
                throw new AcpExecutionError(
                    "Wait for the native session's running operation to finish",
                    {},
                    "session_busy",
                );
            }
            this.#nativeOperations.add(key);
            try {
                const context: AdapterContext = {
                    options,
                    events: this.#store.events,
                    previewThroughAcp: async (request: NativeSessionPreviewRequest) =>
                        await this.#queryProcesses.previewEvents(
                            options,
                            request.nativeSessionId,
                            request.eventLimit,
                            request.cursor,
                        ),
                };
                return await this.#adapters(options.agent).previewSessionEvents(
                    { nativeSessionId, eventLimit, cursor },
                    context,
                );
            } finally {
                this.#nativeOperations.delete(key);
            }
        });

    readonly loadSessionEvents = async (
        options: AcpPrepareOptions,
        eventLimit: number,
        cursor: string | null,
    ): Promise<AcpNativeEventReplay> =>
        this.#operations.run(options, async (options) => {
            return await this.#executionProcesses.use(options.sessionId, async () => {
                const runtime = await this.ensureSession(options);
                return await runtime.loadHistoryEvents(eventLimit, cursor, options.signal);
            });
        });

    readonly openNativeSession = async (
        options: AcpPrepareOptions,
        origin: NativeSessionOrigin,
    ): Promise<{
        readonly sessionId: string;
        readonly prepared: AcpPreparedSession;
    }> =>
        this.#operations.run(options, async (options) => {
            const key = `${options.agent.id}:${origin.nativeSessionId}`;
            if (this.#nativeOperations.has(key)) {
                throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
            }
            const linked = this.#store.findNative(options.agent.id, origin.nativeSessionId);
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
            const existing = linked[0];
            if (origin.kind === "import" && existing !== undefined) {
                return await this.#executionProcesses.use(existing.sessionId, async () => {
                    const runtime = await this.ensureSession({
                        ...options,
                        sessionId: existing.sessionId,
                    });
                    if (this.#executions.command(existing.sessionId) !== undefined || this.#nativeOperations.has(key)) {
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
            if (
                this.#executionProcesses.get(options.sessionId) !== undefined ||
                this.#executionProcesses.pending(options.sessionId) !== undefined ||
                this.#store.read(options.sessionId) instanceof FoundAcpStoredSession
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
                    const runtime = await this.#startPreparation({ ...options, origin }, { kind: "interactive-only" });
                    const openedKey = `${options.agent.id}:${runtime.nativeSessionId()}`;
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
