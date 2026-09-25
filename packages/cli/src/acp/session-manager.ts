import { AcpProcessSession } from "./process-session.ts";

export { createWritableAcpStream } from "./process-endpoint.ts";

import type { NativeSessionHistory, SessionConfigOption } from "@moxt-ai/mobius-protocol";
import { type OperationMetrics, unmeasuredOperationMetrics } from "../infra/operation-metrics.ts";
import { isNativeChatSessionId } from "../native-sessions/chat-agent.ts";
import { AcpExecutionError } from "./acp-error.ts";
import type { NativeSessionOrigin, NativeSessionPage } from "./native-session.ts";
import { AcpProcessPool, type AcpProcessRetention } from "./process-pool.ts";
import {
    type AcpSessionStore,
    DeletedAcpStoredSession,
    FoundAcpStoredSession,
    MemoryAcpSessionStore,
    MissingAcpStoredSession,
} from "./session-store.ts";

const SESSION_CONTROL_TIMEOUT_MILLISECONDS = 30_000;

export { AcpConfigurationValueUnavailableError, AcpExecutionError } from "./acp-error.ts";
export {
    type AcpAgentSettingsInspectionOptions,
    AcpAgentSettingsSnapshot,
    type AcpConfigureOptions,
    type AcpElicitationResponseOptions,
    type AcpNativeHistoryReader,
    type AcpPermissionResponseOptions,
    AcpPreparedSession,
    type AcpPrepareOptions,
    type AcpPromptResult,
    type AcpSessionObserver,
    type AcpSteerOptions,
    type AcpTurnOptions,
    NullAcpSessionObserver,
} from "./session-contracts.ts";

import {
    type AcpAgentSettingsInspectionOptions,
    AcpAgentSettingsSnapshot,
    type AcpConfigureOptions,
    type AcpElicitationResponseOptions,
    type AcpNativeHistoryReader,
    type AcpPermissionResponseOptions,
    type AcpPreparedSession,
    type AcpPrepareOptions,
    type AcpPromptResult,
    type AcpSessionObserver,
    type AcpSteerOptions,
    type AcpTurnOptions,
    NullAcpSessionObserver,
} from "./session-contracts.ts";

export class AcpSessionManager {
    readonly #processes = new AcpProcessPool();
    readonly #activeCommandIds = new Map<string, string>();
    readonly #agentSettingsObserver = new NullAcpSessionObserver();
    readonly #nativeOperations = new Set<string>();
    readonly #nativeBrowserObserver = new NullAcpSessionObserver();
    readonly #nativeBrowserPreparing = new Map<string, Promise<AcpProcessSession>>();
    readonly #nativeBrowserSessions = new Map<string, AcpProcessSession>();
    readonly #nativeBrowserStore = new MemoryAcpSessionStore();
    readonly #nativeBrowserUseCounts = new Map<string, number>();
    readonly #cancellationRequests = new Map<string, Promise<void>>();
    readonly #preparing = new Map<string, Promise<AcpProcessSession>>();
    readonly #sessionUseCounts = new Map<string, number>();
    readonly #sessions = new Map<string, AcpProcessSession>();
    readonly #store: AcpSessionStore;
    readonly #nativeHistoryReader: AcpNativeHistoryReader | null;
    readonly #sessionIdentity: "assigned" | "native";
    #observer: AcpSessionObserver;

    constructor(
        observer: AcpSessionObserver = new NullAcpSessionObserver(),
        store: AcpSessionStore = new MemoryAcpSessionStore(),
        nativeHistoryReader: AcpNativeHistoryReader | null = null,
        sessionIdentity: "assigned" | "native" = "assigned",
    ) {
        this.#observer = observer;
        this.#store = store;
        this.#nativeHistoryReader = nativeHistoryReader;
        this.#sessionIdentity = sessionIdentity;
    }

    readonly setObserver = (observer: AcpSessionObserver): void => {
        this.#observer = observer;
    };

    #touchSession(sessionId: string): void {
        const runtime = this.#sessions.get(sessionId);
        if (runtime === undefined) {
            return;
        }
        this.#processes.touch(runtime);
    }

    #touchExpectedSession(sessionId: string, expected: AcpProcessSession): void {
        if (this.#sessions.get(sessionId) !== expected) {
            return;
        }
        this.#processes.touch(expected);
    }

    #touchNativeBrowserSession(sessionId: string): void {
        const runtime = this.#nativeBrowserSessions.get(sessionId);
        if (runtime === undefined) {
            return;
        }
        this.#processes.touch(runtime);
    }

    #touchExpectedNativeBrowserSession(sessionId: string, expected: AcpProcessSession): void {
        if (this.#nativeBrowserSessions.get(sessionId) !== expected) {
            return;
        }
        this.#processes.touch(expected);
    }

    #beginSessionUse(sessionId: string): void {
        this.#sessionUseCounts.set(sessionId, (this.#sessionUseCounts.get(sessionId) ?? 0) + 1);
        this.#touchSession(sessionId);
    }

    #endSessionUse(sessionId: string): void {
        const count = this.#sessionUseCounts.get(sessionId) ?? 0;
        if (count <= 1) {
            this.#sessionUseCounts.delete(sessionId);
        } else {
            this.#sessionUseCounts.set(sessionId, count - 1);
        }
        this.#touchSession(sessionId);
        this.#processes.notifyChanged();
    }

    #beginNativeBrowserUse(sessionId: string): void {
        this.#nativeBrowserUseCounts.set(sessionId, (this.#nativeBrowserUseCounts.get(sessionId) ?? 0) + 1);
        this.#touchNativeBrowserSession(sessionId);
    }

    #endNativeBrowserUse(sessionId: string): void {
        const count = this.#nativeBrowserUseCounts.get(sessionId) ?? 0;
        if (count <= 1) {
            this.#nativeBrowserUseCounts.delete(sessionId);
        } else {
            this.#nativeBrowserUseCounts.set(sessionId, count - 1);
        }
        this.#touchNativeBrowserSession(sessionId);
        this.#processes.notifyChanged();
    }

    #isNativeSessionOperationActive(sessionId: string): boolean {
        const stored = this.#store.read(sessionId);
        return (
            stored instanceof FoundAcpStoredSession &&
            this.#nativeOperations.has(`${stored.session.agentId}:${stored.session.nativeSessionId}`)
        );
    }

    #retention(sessionId: string, kind: "execution" | "browser"): AcpProcessRetention {
        if (kind === "execution") {
            return {
                isBusy: () =>
                    this.#activeCommandIds.has(sessionId) ||
                    this.#cancellationRequests.has(sessionId) ||
                    this.#preparing.has(sessionId) ||
                    (this.#sessionUseCounts.get(sessionId) ?? 0) > 0 ||
                    this.#isNativeSessionOperationActive(sessionId),
                retire: (runtime) => this.#retireSessionProcess(sessionId, runtime, () => runtime.close()),
            };
        }
        return {
            isBusy: () =>
                this.#nativeBrowserPreparing.has(sessionId) || (this.#nativeBrowserUseCounts.get(sessionId) ?? 0) > 0,
            retire: (runtime) => this.#retireNativeBrowserProcess(sessionId, runtime, () => runtime.close()),
        };
    }

    async #retireSessionProcess(
        sessionId: string,
        runtime: AcpProcessSession,
        close: () => Promise<void>,
    ): Promise<void> {
        const retained = this.#sessions.get(sessionId) === runtime;
        if (retained) {
            this.#sessions.delete(sessionId);
        }
        try {
            await this.#processes.retire(runtime, close);
        } finally {
            if (retained && this.#sessionIdentity === "native") {
                const stored = this.#store.read(sessionId);
                if (
                    stored instanceof FoundAcpStoredSession &&
                    isNativeChatSessionId(stored.session.agentId, sessionId)
                ) {
                    this.#store.remove(sessionId);
                }
            }
        }
    }

    async #retireNativeBrowserProcess(
        sessionId: string,
        runtime: AcpProcessSession,
        close: () => Promise<void>,
    ): Promise<void> {
        const retained = this.#nativeBrowserSessions.get(sessionId) === runtime;
        if (retained) {
            this.#nativeBrowserSessions.delete(sessionId);
            this.#nativeBrowserStore.remove(sessionId);
        }
        await this.#processes.retire(runtime, close);
    }

    async #startRetainedSessionProcess(
        options: AcpPrepareOptions,
        start: () => Promise<AcpProcessSession>,
    ): Promise<AcpProcessSession> {
        const runtime = await this.#processes.startRetained(
            options.signal,
            start,
            this.#retention(options.sessionId, "execution"),
        );
        this.#sessions.set(options.sessionId, runtime);
        return runtime;
    }

    async #startRetainedNativeBrowserProcess(
        options: AcpPrepareOptions,
        start: () => Promise<AcpProcessSession>,
    ): Promise<AcpProcessSession> {
        const runtime = await this.#processes.startRetained(
            options.signal,
            start,
            this.#retention(options.sessionId, "browser"),
        );
        this.#nativeBrowserSessions.set(options.sessionId, runtime);
        return runtime;
    }

    async #startNativeBrowserPreparation(options: AcpPrepareOptions): Promise<AcpProcessSession> {
        const operation = (async () => {
            try {
                return await this.#startRetainedNativeBrowserProcess(
                    options,
                    async () =>
                        await AcpProcessSession.startNativeSessionBrowser(
                            options,
                            () => this.#nativeBrowserObserver,
                            this.#nativeBrowserStore,
                        ),
                );
            } finally {
                this.#nativeBrowserPreparing.delete(options.sessionId);
                this.#processes.notifyChanged();
            }
        })();
        this.#nativeBrowserPreparing.set(options.sessionId, operation);
        return await operation;
    }

    async #replaceNativeBrowserPreparation(
        existing: AcpProcessSession,
        options: AcpPrepareOptions,
    ): Promise<AcpProcessSession> {
        const operation = (async () => {
            try {
                await this.#retireNativeBrowserProcess(options.sessionId, existing, async () => await existing.close());
                return await this.#startRetainedNativeBrowserProcess(
                    options,
                    async () =>
                        await AcpProcessSession.startNativeSessionBrowser(
                            options,
                            () => this.#nativeBrowserObserver,
                            this.#nativeBrowserStore,
                        ),
                );
            } finally {
                this.#nativeBrowserPreparing.delete(options.sessionId);
                this.#processes.notifyChanged();
            }
        })();
        this.#nativeBrowserPreparing.set(options.sessionId, operation);
        return await operation;
    }

    async #startPreparation(
        options: AcpPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpProcessSession> {
        const operation = (async () => {
            try {
                return await this.#startRetainedSessionProcess(
                    options,
                    async () =>
                        await AcpProcessSession.start(
                            options.origin === undefined &&
                                this.#sessionIdentity === "native" &&
                                isNativeChatSessionId(options.agent.id, options.sessionId) &&
                                this.#store.read(options.sessionId) instanceof MissingAcpStoredSession
                                ? { ...options, origin: { kind: "import", nativeSessionId: options.sessionId } }
                                : options,
                            () => this.#observer,
                            this.#store,
                            metrics,
                        ),
                );
            } finally {
                this.#preparing.delete(options.sessionId);
                this.#processes.notifyChanged();
            }
        })();
        this.#preparing.set(options.sessionId, operation);
        return await operation;
    }

    async #replacePreparation(
        existing: AcpProcessSession,
        options: AcpPrepareOptions,
        metrics: OperationMetrics,
    ): Promise<AcpProcessSession> {
        const operation = (async () => {
            try {
                await this.#retireSessionProcess(
                    options.sessionId,
                    existing,
                    async () => await metrics.measure("runtime-replacement-close", async () => await existing.close()),
                );
                this.#store.remove(options.sessionId);
                return await this.#startRetainedSessionProcess(
                    options,
                    async () => await AcpProcessSession.start(options, () => this.#observer, this.#store, metrics),
                );
            } finally {
                this.#preparing.delete(options.sessionId);
                this.#processes.notifyChanged();
            }
        })();
        this.#preparing.set(options.sessionId, operation);
        return await operation;
    }

    async #replaceExecutionPreparation(
        existing: AcpProcessSession,
        options: AcpPrepareOptions,
    ): Promise<AcpProcessSession> {
        const desiredConfigOptions = existing.prepared().configOptions;
        const operation = (async () => {
            try {
                await this.#retireSessionProcess(options.sessionId, existing, async () => await existing.close());
                const runtime = await this.#startRetainedSessionProcess(
                    options,
                    async () => await AcpProcessSession.start(options, () => this.#observer, this.#store),
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
            } finally {
                this.#preparing.delete(options.sessionId);
                this.#processes.notifyChanged();
            }
        })();
        this.#preparing.set(options.sessionId, operation);
        return await operation;
    }

    readonly prepareSession = async (
        options: AcpPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpPreparedSession> => {
        const stored = metrics.measureSync("session-state-read", () => this.#store.read(options.sessionId));
        if (stored instanceof DeletedAcpStoredSession) {
            throw new AcpExecutionError(
                "The native Agent session was deleted. Start a new chat.",
                {},
                "native_session_deleted",
            );
        }
        if (
            stored instanceof FoundAcpStoredSession &&
            this.#nativeOperations.has(`${stored.session.agentId}:${stored.session.nativeSessionId}`)
        ) {
            throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
        }
        const pending = this.#preparing.get(options.sessionId);
        if (pending !== undefined) {
            const runtime = await metrics.measure("session-preparation-wait", async () => await pending);
            if (runtime.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#touchExpectedSession(options.sessionId, runtime);
                return runtime.prepared();
            }
            return await this.prepareSession(options, metrics);
        }
        const existing = this.#sessions.get(options.sessionId);
        if (existing !== undefined) {
            if (existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#touchExpectedSession(options.sessionId, existing);
                return existing.prepared();
            }
            if (!existing.canRebind()) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            const runtime = await this.#replacePreparation(existing, options, metrics);
            return runtime.prepared();
        }
        const runtime = await this.#startPreparation(options, metrics);
        return runtime.prepared();
    };

    /**
     * Opens a short-lived native ACP session only to read the local Agent's
     * authoritative settings. Its identity and store are private to this
     * operation and never become a Mobius Session.
     */
    readonly inspectAgentSettings = async (
        options: AcpAgentSettingsInspectionOptions,
    ): Promise<AcpAgentSettingsSnapshot> =>
        await this.#processes.runTransient(
            options.signal,
            async () =>
                await AcpProcessSession.start(
                    {
                        ...options,
                        sessionId: `agent-settings-${crypto.randomUUID()}`,
                    },
                    () => this.#agentSettingsObserver,
                    new MemoryAcpSessionStore(),
                ),
            async (runtime) => {
                const prepared = runtime.prepared();
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
                return new AcpAgentSettingsSnapshot(prepared.agentName, prepared.agentVersion, configOptions);
            },
            async (runtime) => await runtime.close(),
        );

    /**
     * Retained for Agents that expose a separate persisted configuration channel.
     * Use inspectAgentSettings for Agent-scoped settings discovery.
     */
    readonly inspectSession = async (
        options: AcpPrepareOptions,
        metrics: OperationMetrics = unmeasuredOperationMetrics,
    ): Promise<AcpPreparedSession> => {
        if (this.#preparing.has(options.sessionId) || this.#sessions.has(options.sessionId)) {
            throw new AcpExecutionError("The configuration inspection session is already in use", {}, "session_busy");
        }
        this.#beginSessionUse(options.sessionId);
        try {
            const runtime = await this.#startPreparation(options, metrics);
            try {
                return runtime.prepared();
            } finally {
                try {
                    await this.#retireSessionProcess(options.sessionId, runtime, async () => await runtime.close());
                } finally {
                    this.#store.remove(options.sessionId);
                }
            }
        } finally {
            this.#endSessionUse(options.sessionId);
        }
    };

    readonly prepareExecutionSession = async (options: AcpPrepareOptions): Promise<AcpPreparedSession> => {
        const pending = this.#preparing.get(options.sessionId);
        if (pending !== undefined) {
            await pending;
            return await this.prepareExecutionSession(options);
        }
        const existing = this.#sessions.get(options.sessionId);
        if (existing === undefined) {
            return (await this.#startPreparation(options)).prepared();
        }
        if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
            throw new AcpExecutionError(
                "The agent or workspace cannot change after a conversation has started",
                {},
                "session_identity_mismatch",
            );
        }
        if (existing.usesEnvironment(options.agent.environment)) {
            this.#touchExpectedSession(options.sessionId, existing);
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
    };

    readonly prepareNativeSessionBrowser = async (options: AcpPrepareOptions): Promise<AcpPreparedSession> => {
        const pending = this.#nativeBrowserPreparing.get(options.sessionId);
        if (pending !== undefined) {
            const runtime = await pending;
            if (runtime.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#touchExpectedNativeBrowserSession(options.sessionId, runtime);
                return runtime.prepared();
            }
            return await this.prepareNativeSessionBrowser(options);
        }
        const existing = this.#nativeBrowserSessions.get(options.sessionId);
        if (existing !== undefined) {
            if (existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#touchExpectedNativeBrowserSession(options.sessionId, existing);
                return existing.prepared();
            }
            if (!existing.canRebind()) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            const runtime = await this.#replaceNativeBrowserPreparation(existing, options);
            return runtime.prepared();
        }
        const runtime = await this.#startNativeBrowserPreparation(options);
        return runtime.prepared();
    };

    readonly configureSession = async (options: AcpConfigureOptions): Promise<readonly SessionConfigOption[]> => {
        this.#beginSessionUse(options.sessionId);
        try {
            const runtime = await this.ensureSession(options);
            return await runtime.configure(options);
        } finally {
            this.#endSessionUse(options.sessionId);
        }
    };

    readonly cancelPrompt = async (sessionId: string): Promise<void> => {
        const existing = this.#cancellationRequests.get(sessionId);
        if (existing !== undefined) {
            await existing;
            return;
        }
        const cancellation = (async () => {
            const runtime = this.#sessions.get(sessionId);
            if (runtime !== undefined) {
                try {
                    await runtime.cancel();
                } finally {
                    if (this.#sessions.get(sessionId) === runtime) {
                        this.#sessions.delete(sessionId);
                        this.#processes.releaseClosed(runtime);
                    }
                }
            }
        })();
        this.#cancellationRequests.set(sessionId, cancellation);
        await cancellation;
    };

    readonly steerPrompt = async (options: AcpSteerOptions): Promise<string> => {
        if (this.#activeCommandIds.get(options.sessionId) !== options.targetCommandId) {
            throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
        }
        const pending = this.#preparing.get(options.sessionId);
        if (pending !== undefined) {
            await pending;
        }
        if (this.#activeCommandIds.get(options.sessionId) !== options.targetCommandId) {
            throw new AcpExecutionError("The target turn is no longer active", {}, "steering_target_unavailable");
        }
        const runtime = this.#sessions.get(options.sessionId);
        if (runtime === undefined || !runtime.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
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
    };

    readonly runPrompt = async (options: AcpTurnOptions): Promise<AcpPromptResult> => {
        const stored = this.#store.read(options.sessionId);
        if (
            stored instanceof FoundAcpStoredSession &&
            this.#nativeOperations.has(`${stored.session.agentId}:${stored.session.nativeSessionId}`)
        ) {
            throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
        }
        if (this.#activeCommandIds.has(options.sessionId)) {
            throw new AcpExecutionError("Another prompt is already running in this conversation", {}, "session_busy");
        }
        this.#activeCommandIds.set(options.sessionId, options.commandId);
        try {
            if (this.#cancellationRequests.has(options.sessionId)) {
                return { stopReason: "cancelled" };
            }
            const runtime = await this.ensureSession(options);
            if (this.#nativeOperations.has(`${options.agent.id}:${runtime.nativeSessionId()}`)) {
                throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
            }
            if (this.#cancellationRequests.has(options.sessionId)) {
                return { stopReason: "cancelled" };
            }
            try {
                const result = await runtime.prompt(options);
                return this.#cancellationRequests.has(options.sessionId) ? { stopReason: "cancelled" } : result;
            } catch (error) {
                if (this.#cancellationRequests.has(options.sessionId)) {
                    await this.#cancellationRequests.get(options.sessionId);
                    return { stopReason: "cancelled" };
                }
                throw error;
            }
        } catch (error) {
            const failedRuntime = this.#sessions.get(options.sessionId);
            if (failedRuntime !== undefined) {
                await this.#retireSessionProcess(
                    options.sessionId,
                    failedRuntime,
                    async () => await failedRuntime.close(),
                );
            }
            if (this.#cancellationRequests.has(options.sessionId)) {
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
                await this.#cancellationRequests.get(options.sessionId);
            } finally {
                if (this.#activeCommandIds.get(options.sessionId) === options.commandId) {
                    this.#activeCommandIds.delete(options.sessionId);
                }
                this.#cancellationRequests.delete(options.sessionId);
                this.#touchSession(options.sessionId);
                this.#processes.notifyChanged();
            }
        }
    };

    readonly respondPermission = async (options: AcpPermissionResponseOptions): Promise<void> => {
        const runtime = this.#sessions.get(options.sessionId);
        if (runtime === undefined) {
            throw new AcpExecutionError("The permission request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondPermission(options);
    };

    readonly respondElicitation = async (options: AcpElicitationResponseOptions): Promise<void> => {
        const runtime = this.#sessions.get(options.sessionId);
        if (runtime === undefined) {
            throw new AcpExecutionError("The elicitation request session is unavailable", {}, "session_not_found");
        }
        await runtime.respondElicitation(options);
    };

    readonly close = async (): Promise<void> => {
        const sessions = [...this.#sessions.entries()];
        const nativeBrowserSessions = [...this.#nativeBrowserSessions.entries()];
        await Promise.all([
            ...sessions.map(
                async ([sessionId, runtime]) =>
                    await this.#retireSessionProcess(sessionId, runtime, async () => await runtime.close()),
            ),
            ...nativeBrowserSessions.map(
                async ([sessionId, runtime]) =>
                    await this.#retireNativeBrowserProcess(sessionId, runtime, async () => await runtime.close()),
            ),
        ]);
    };

    readonly findSessions = (sessionIds: readonly string[]) =>
        sessionIds.flatMap((sessionId) => {
            const stored = this.#store.read(sessionId);
            return stored instanceof FoundAcpStoredSession ? [stored.session] : [];
        });

    readonly findLinkedSessions = (agentId: string, nativeSessionId: string) =>
        this.#store.findNative(agentId, nativeSessionId);

    readonly hasPreparedSession = (
        sessionId: string,
        agentId: string,
        cwd: string,
        additionalDirectories: readonly string[],
    ): boolean => this.#sessions.get(sessionId)?.belongsTo(agentId, cwd, additionalDirectories) === true;

    readonly createNativeSession = async (options: AcpPrepareOptions): Promise<string> => {
        const temporarySessionId = `new-${crypto.randomUUID()}`;
        const temporaryOptions = { ...options, sessionId: temporarySessionId };
        this.#beginSessionUse(temporarySessionId);
        try {
            const runtime = await this.#startPreparation(temporaryOptions);
            let adopted = false;
            try {
                const nativeSessionId = runtime.nativeSessionId();
                if (
                    !isNativeChatSessionId(options.agent.id, nativeSessionId) ||
                    this.#sessions.has(nativeSessionId) ||
                    !(this.#store.read(nativeSessionId) instanceof MissingAcpStoredSession)
                ) {
                    throw new AcpExecutionError(
                        "The Agent returned an invalid new Session ID",
                        {},
                        "invalid_native_session_response",
                    );
                }
                runtime.adoptNativeSessionId(nativeSessionId);
                this.#sessions.delete(temporarySessionId);
                this.#sessions.set(nativeSessionId, runtime);
                this.#processes.retain(runtime, this.#retention(nativeSessionId, "execution"));
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
            this.#endSessionUse(temporarySessionId);
        }
    };

    readonly ensureSession = async (options: AcpPrepareOptions): Promise<AcpProcessSession> => {
        const existing = this.#sessions.get(options.sessionId);
        if (existing !== undefined) {
            if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            this.#touchExpectedSession(options.sessionId, existing);
            return existing;
        }
        await this.prepareSession(options);
        const started = this.#sessions.get(options.sessionId);
        if (started === undefined) {
            throw new AcpExecutionError("ACP session did not start");
        }
        return started;
    };

    async #ensureNativeSessionBrowser(options: AcpPrepareOptions): Promise<AcpProcessSession> {
        const existing = this.#nativeBrowserSessions.get(options.sessionId);
        if (existing !== undefined) {
            if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            this.#touchExpectedNativeBrowserSession(options.sessionId, existing);
            return existing;
        }
        await this.prepareNativeSessionBrowser(options);
        const started = this.#nativeBrowserSessions.get(options.sessionId);
        if (started === undefined) {
            throw new AcpExecutionError("ACP native session browser did not start");
        }
        return started;
    }

    readonly listNativeSessions = async (
        options: AcpPrepareOptions,
        cursor: string | null,
    ): Promise<NativeSessionPage> => {
        this.#beginNativeBrowserUse(options.sessionId);
        try {
            return await (await this.#ensureNativeSessionBrowser(options)).listNativeSessions(cursor, options.signal);
        } finally {
            this.#endNativeBrowserUse(options.sessionId);
        }
    };

    readonly previewNativeSession = async (
        options: AcpPrepareOptions,
        nativeSessionId: string,
    ): Promise<NativeSessionHistory> => {
        const key = `${options.agent.id}:${nativeSessionId}`;
        const linked = this.#store.findNative(options.agent.id, nativeSessionId);
        if (
            this.#nativeOperations.has(key) ||
            linked.some((entry) => this.#activeCommandIds.has(entry.sessionId) || this.#preparing.has(entry.sessionId))
        ) {
            throw new AcpExecutionError(
                "Wait for the native session's running operation to finish",
                {},
                "session_busy",
            );
        }
        this.#nativeOperations.add(key);
        try {
            return await this.#processes.runTransient(
                options.signal,
                async () =>
                    await AcpProcessSession.startNativeSessionBrowser(
                        options,
                        () => this.#nativeBrowserObserver,
                        new MemoryAcpSessionStore(),
                    ),
                async (runtime) => {
                    runtime.selectNativeSession(nativeSessionId);
                    return await runtime.loadHistory(options.signal);
                },
                async (runtime) => await runtime.closeProcess(),
            );
        } finally {
            this.#nativeOperations.delete(key);
        }
    };

    readonly loadSessionHistory = async (options: AcpPrepareOptions): Promise<NativeSessionHistory> => {
        this.#beginSessionUse(options.sessionId);
        try {
            const runtime = await this.ensureSession(options);
            const stored = this.#store.read(options.sessionId);
            if (stored instanceof FoundAcpStoredSession && this.#nativeHistoryReader !== null) {
                const history = await this.#nativeHistoryReader.read(
                    options,
                    stored.session.nativeSessionId,
                    runtime.nativeHistoryTurn,
                );
                if (history !== null) {
                    return history;
                }
            }
            return await runtime.loadHistory(options.signal);
        } finally {
            this.#endSessionUse(options.sessionId);
        }
    };

    readonly openNativeSession = async (
        options: AcpPrepareOptions,
        origin: NativeSessionOrigin,
    ): Promise<{
        readonly sessionId: string;
        readonly prepared: AcpPreparedSession;
    }> => {
        const key = `${options.agent.id}:${origin.nativeSessionId}`;
        if (this.#nativeOperations.has(key)) {
            throw new AcpExecutionError("The native session is being managed", {}, "session_busy");
        }
        const linked = this.#store.findNative(options.agent.id, origin.nativeSessionId);
        if (
            linked.some((entry) => this.#activeCommandIds.has(entry.sessionId) || this.#preparing.has(entry.sessionId))
        ) {
            throw new AcpExecutionError(
                "Wait for the native session's running operation to finish",
                {},
                "session_busy",
            );
        }
        const existing = linked[0];
        if (origin.kind === "import" && existing !== undefined) {
            this.#beginSessionUse(existing.sessionId);
            try {
                const runtime = await this.ensureSession({
                    ...options,
                    sessionId: existing.sessionId,
                });
                if (this.#activeCommandIds.has(existing.sessionId) || this.#nativeOperations.has(key)) {
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
            } finally {
                this.#endSessionUse(existing.sessionId);
            }
        }
        if (
            this.#sessions.has(options.sessionId) ||
            this.#preparing.has(options.sessionId) ||
            this.#store.read(options.sessionId) instanceof FoundAcpStoredSession ||
            this.#store.read(options.sessionId) instanceof DeletedAcpStoredSession
        ) {
            throw new AcpExecutionError("The destination conversation already exists", {}, "session_identity_mismatch");
        }
        this.#beginSessionUse(options.sessionId);
        this.#nativeOperations.add(key);
        try {
            const runtime = await this.#startPreparation({ ...options, origin });
            const openedKey = `${options.agent.id}:${runtime.nativeSessionId()}`;
            this.#nativeOperations.add(openedKey);
            try {
                return {
                    sessionId: options.sessionId,
                    prepared: runtime.prepared(),
                };
            } finally {
                this.#nativeOperations.delete(openedKey);
                this.#processes.notifyChanged();
            }
        } catch (error) {
            this.#store.remove(options.sessionId);
            const runtime = this.#sessions.get(options.sessionId);
            if (runtime !== undefined) {
                await this.#retireSessionProcess(options.sessionId, runtime, async () => await runtime.closeProcess());
            }
            throw error;
        } finally {
            this.#nativeOperations.delete(key);
            this.#endSessionUse(options.sessionId);
        }
    };

    readonly deleteNativeSession = async (
        options: AcpPrepareOptions,
        nativeSessionId: string,
    ): Promise<readonly string[]> => {
        this.#beginNativeBrowserUse(options.sessionId);
        try {
            const runtime = await this.#ensureNativeSessionBrowser(options);
            const key = `${options.agent.id}:${nativeSessionId}`;
            const linked = this.#store.findNative(options.agent.id, nativeSessionId);
            if (
                this.#nativeOperations.has(key) ||
                linked.some(
                    (entry) => this.#activeCommandIds.has(entry.sessionId) || this.#preparing.has(entry.sessionId),
                )
            ) {
                throw new AcpExecutionError(
                    "Wait for the native session's running operation to finish",
                    {},
                    "session_busy",
                );
            }
            this.#nativeOperations.add(key);
            try {
                for (const entry of linked) {
                    const active = this.#sessions.get(entry.sessionId);
                    if (active !== undefined && active !== runtime) {
                        await this.#retireSessionProcess(entry.sessionId, active, async () => await active.close());
                    }
                }
                options.signal.throwIfAborted();
                await runtime.deleteNativeSession(nativeSessionId, options.signal);
                const deleted = this.#store.markDeleted(options.agent.id, nativeSessionId);
                if (runtime.nativeSessionId() === nativeSessionId) {
                    await this.#retireNativeBrowserProcess(
                        options.sessionId,
                        runtime,
                        async () => await runtime.close(),
                    );
                }
                return deleted;
            } finally {
                this.#nativeOperations.delete(key);
                this.#processes.notifyChanged();
            }
        } finally {
            this.#endNativeBrowserUse(options.sessionId);
        }
    };
}
