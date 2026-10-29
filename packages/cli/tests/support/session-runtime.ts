import { AdapterRegistry } from "../../src/engine/acp/adapter/adapter-registry.ts";
import type { AcpContentExternalizer } from "../../src/engine/acp/content/content-externalizer.ts";
import type { AdapterResolver } from "../../src/engine/acp/native-history/preview-contract.ts";
import type { OperationMetrics } from "../../src/engine/infra/operation-metrics.ts";
import type {
    AgentSettingsInspectionOptions,
    SessionConfigureOptions,
    SessionPrepareOptions,
    SessionSteerOptions,
    SessionTurnOptions,
} from "../../src/engine/session/api/session-api.ts";
import { type ClosedSessionHandling, SessionManager } from "../../src/engine/session/manager/session-manager.ts";
import { AgentProcessPool } from "../../src/engine/session/process/agent-process-pool.ts";

export type TestSessionPrepareOptions = Omit<SessionPrepareOptions, "adapter">;

/** Composes real session resources for direct session scenarios, with Runtime owning the adapters. */
export class SessionRuntimeFixture {
    readonly sessions: SessionManager;
    readonly adapters: AdapterRegistry;

    constructor(
        options: Omit<ConstructorParameters<typeof SessionManager>[0], "processes"> & {
            readonly adapters: AdapterResolver;
            readonly contentExternalizer: AcpContentExternalizer;
            readonly maxProcesses: number | null;
        },
    ) {
        const processes = new AgentProcessPool(options.maxProcesses ?? undefined, options.timer);
        this.adapters = new AdapterRegistry(options.adapters, {
            processes,
            contentExternalizer: options.contentExternalizer,
        });
        this.sessions = new SessionManager({ ...options, processes });
    }

    readonly resolveAgent = async (agent: SessionPrepareOptions["agent"]) => ({
        agent,
        adapter: this.adapters.resolve(agent),
    });

    readonly prepareSession = (
        options: TestSessionPrepareOptions,
        metrics?: OperationMetrics,
        closed?: ClosedSessionHandling,
    ) => this.sessions.prepareSession({ ...options, adapter: this.adapters.resolve(options.agent) }, metrics, closed);

    readonly restoreSession = (
        options: TestSessionPrepareOptions,
        metrics?: OperationMetrics,
        closed?: ClosedSessionHandling,
    ) => this.sessions.restoreSession({ ...options, adapter: this.adapters.resolve(options.agent) }, metrics, closed);

    readonly inspectSession = (options: TestSessionPrepareOptions, metrics?: OperationMetrics) =>
        this.sessions.inspectSession({ ...options, adapter: this.adapters.resolve(options.agent) }, metrics);

    readonly prepareExecutionSession = (options: TestSessionPrepareOptions) =>
        this.sessions.prepareExecutionSession({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly ensureSession = (options: TestSessionPrepareOptions) =>
        this.sessions.ensureSession({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly createNativeSession = (options: TestSessionPrepareOptions) =>
        this.sessions.createNativeSession({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly inspectAgentSettings = (options: Omit<AgentSettingsInspectionOptions, "adapter">) =>
        this.sessions.inspectAgentSettings({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly configureSession = (options: Omit<SessionConfigureOptions, "adapter">) =>
        this.sessions.configureSession({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly runPrompt = (options: Omit<SessionTurnOptions, "adapter">) =>
        this.sessions.runPrompt({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly steerPrompt = (options: Omit<SessionSteerOptions, "adapter">) =>
        this.sessions.steerPrompt({ ...options, adapter: this.adapters.resolve(options.agent) });

    readonly nativeSessionCapabilities = (options: TestSessionPrepareOptions) =>
        this.adapters.resolve(options.agent).getCapabilities(options.cwd, options.signal);

    readonly listNativeSessions = (options: TestSessionPrepareOptions, cursor: string | null) =>
        this.adapters.resolve(options.agent).listSessions(options.cwd, cursor, options.signal);

    readonly previewNativeSessionEvents = (
        options: TestSessionPrepareOptions,
        nativeSessionId: string,
        eventLimit: number,
        cursor: string | null,
    ) =>
        this.sessions.withNativeSessionOperation(
            { ...options, adapter: this.adapters.resolve(options.agent) },
            nativeSessionId,
            (target) =>
                target.adapter.readSessionHistory(
                    target.cwd,
                    target.additionalDirectories,
                    {
                        nativeSessionId,
                        eventLimit,
                        cursor,
                        sessionId: target.sessionId,
                    },
                    target.signal,
                ),
        );

    readonly loadSessionEvents = (options: TestSessionPrepareOptions, eventLimit: number, cursor: string | null) =>
        this.sessions.loadSessionEvents(
            { ...options, adapter: this.adapters.resolve(options.agent) },
            eventLimit,
            cursor,
        );

    readonly openNativeSession = (
        options: TestSessionPrepareOptions,
        origin: Parameters<SessionManager["openNativeSession"]>[1],
    ) =>
        this.sessions.openNativeSession(
            { ...options, adapter: this.adapters.resolve(options.agent) },
            origin,
            async () => ({ agent: options.agent, adapter: this.adapters.resolve(options.agent) }),
        );

    readonly close = async (): Promise<void> => {
        try {
            await this.sessions.close();
        } finally {
            await this.adapters.close();
        }
    };

    readonly setObserver = (...args: Parameters<SessionManager["setObserver"]>) => this.sessions.setObserver(...args);
    readonly recordLifecycleEvent = (...args: Parameters<SessionManager["recordLifecycleEvent"]>) =>
        this.sessions.recordLifecycleEvent(...args);
    readonly renameSession = (...args: Parameters<SessionManager["renameSession"]>) =>
        this.sessions.renameSession(...args);
    readonly cancelPrompt = (...args: Parameters<SessionManager["cancelPrompt"]>) =>
        this.sessions.cancelPrompt(...args);
    readonly respondPermission = (...args: Parameters<SessionManager["respondPermission"]>) =>
        this.sessions.respondPermission(...args);
    readonly respondElicitation = (...args: Parameters<SessionManager["respondElicitation"]>) =>
        this.sessions.respondElicitation(...args);
    readonly closeSession = (...args: Parameters<SessionManager["closeSession"]>) =>
        this.sessions.closeSession(...args);
    readonly findSessions = (...args: Parameters<SessionManager["findSessions"]>) =>
        this.sessions.findSessions(...args);
    readonly sessionStatus = (...args: Parameters<SessionManager["sessionStatus"]>) =>
        this.sessions.sessionStatus(...args);
    readonly listSessions = (...args: Parameters<SessionManager["listSessions"]>) =>
        this.sessions.listSessions(...args);
    readonly findLinkedSessions = (...args: Parameters<SessionManager["findLinkedSessions"]>) =>
        this.sessions.findLinkedSessions(...args);
    readonly hasPreparedSession = (...args: Parameters<SessionManager["hasPreparedSession"]>) =>
        this.sessions.hasPreparedSession(...args);
}
