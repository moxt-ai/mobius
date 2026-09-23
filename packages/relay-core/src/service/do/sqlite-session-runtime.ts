import type {
    CreateSessionBindingRequest,
    ProjectScope,
    SessionExport,
    SessionSummary,
} from "../../entity/do/session.ts";
import { SessionRuntimeError } from "../../entity/do/session.ts";
import type {
    SessionCommandRuntime,
    SessionEventStreamRuntime,
    SessionQueryRuntime,
    SessionTransferRuntime,
} from "../../infra/session-runtime.ts";
import type { SessionRecoveryStorage } from "../../storage/do/session-recovery-storage.ts";
import type { SessionCommandService } from "./session-command-service.ts";
import type { SessionEventProjector } from "./session-event-projector.ts";
import type { SessionEventStreams } from "./session-event-stream.ts";
import type { SessionInteractionService } from "./session-interaction-service.ts";
import type { SessionLifecycleService } from "./session-lifecycle-service.ts";
import type { SessionQueryService } from "./session-query-service.ts";
import type { SessionStateService } from "./session-state-service.ts";

export class SqliteSessionRuntime
    implements SessionCommandRuntime, SessionQueryRuntime, SessionEventStreamRuntime, SessionTransferRuntime
{
    readonly #recovery: SessionRecoveryStorage;
    readonly #commands: SessionCommandService;
    readonly #eventProjector: SessionEventProjector;
    readonly #eventStreams: SessionEventStreams;
    readonly #interactions: SessionInteractionService;
    readonly #lifecycle: SessionLifecycleService;
    readonly #queries: SessionQueryService;

    constructor(cx: {
        readonly storages: { readonly recovery: SessionRecoveryStorage };
        readonly services: {
            readonly commands: SessionCommandService;
            readonly eventProjector: SessionEventProjector;
            readonly eventStreams: SessionEventStreams;
            readonly interactions: SessionInteractionService;
            readonly lifecycle: SessionLifecycleService;
            readonly queries: SessionQueryService;
            readonly state: SessionStateService;
        };
    }) {
        this.#recovery = cx.storages.recovery;
        this.#eventProjector = cx.services.eventProjector;
        this.#lifecycle = cx.services.lifecycle;
        this.#queries = cx.services.queries;
        this.#eventStreams = cx.services.eventStreams;
        this.#interactions = cx.services.interactions;
        this.#commands = cx.services.commands;
    }

    readonly createSession: SessionCommandRuntime["createSession"] = (...parameters) =>
        this.#lifecycle.createSession(...parameters);

    readonly listRecoverySessions = () => this.#recovery.list();

    readonly acceptTurn: SessionCommandRuntime["acceptTurn"] = (...parameters) =>
        this.#commands.acceptTurn(...parameters);

    readonly acceptConfiguration: SessionCommandRuntime["acceptConfiguration"] = (...parameters) =>
        this.#commands.acceptConfiguration(...parameters);

    readonly acceptTurnCancellation: SessionCommandRuntime["acceptTurnCancellation"] = (...parameters) =>
        this.#commands.acceptTurnCancellation(...parameters);

    readonly promoteQueuedTurnToSteering: SessionCommandRuntime["promoteQueuedTurnToSteering"] = (...parameters) =>
        this.#commands.promoteQueuedTurnToSteering(...parameters);

    readonly commitEvent: SessionCommandRuntime["commitEvent"] = async (...parameters) => {
        const result = await this.#commands.commitEvent(...parameters);
        if (!result.duplicate) {
            this.#eventStreams.publish(parameters[0], result.committed);
        }
        return result;
    };

    readonly setDefaultBinding: SessionCommandRuntime["setDefaultBinding"] = (...parameters) =>
        this.#commands.setDefaultBinding(...parameters);

    readonly recordNativeHistory: SessionCommandRuntime["recordNativeHistory"] = (...parameters) =>
        this.#lifecycle.recordNativeHistory(...parameters);

    readonly acceptInteractionResponse: SessionCommandRuntime["acceptInteractionResponse"] = (...parameters) =>
        this.#interactions.acceptInteractionResponse(...parameters);

    readonly listPendingDaemonDeliveries: SessionCommandRuntime["listPendingDaemonDeliveries"] = (...parameters) =>
        this.#interactions.listPendingDaemonDeliveries(...parameters);

    readonly markPendingWorkCompleted: SessionCommandRuntime["markPendingWorkCompleted"] = (...parameters) =>
        this.#interactions.markPendingWorkCompleted(...parameters);

    readonly reconcileAttempt: SessionCommandRuntime["reconcileAttempt"] = (...parameters) =>
        this.#interactions.reconcileAttempt(...parameters);

    readonly markRuntimeDisconnected: SessionCommandRuntime["markRuntimeDisconnected"] = (...parameters) =>
        this.#commands.markRuntimeDisconnected(...parameters);

    readonly deleteSession: SessionCommandRuntime["deleteSession"] = (...parameters) =>
        this.#lifecycle.deleteSession(...parameters);

    readonly readSession: SessionQueryRuntime["readSession"] = (...parameters) =>
        this.#queries.readSession(...parameters);

    readonly readConfiguration: SessionQueryRuntime["readConfiguration"] = (...parameters) =>
        this.#queries.readConfiguration(...parameters);

    readonly readNativeHistory: SessionQueryRuntime["readNativeHistory"] = (...parameters) =>
        this.#queries.readNativeHistory(...parameters);

    readonly queryNativeMessages: SessionQueryRuntime["queryNativeMessages"] = (...parameters) =>
        this.#queries.queryNativeMessages(...parameters);

    readonly readTurn: SessionQueryRuntime["readTurn"] = (...parameters) => this.#queries.readTurn(...parameters);

    readonly readTurnRuntime: SessionQueryRuntime["readTurnRuntime"] = (...parameters) =>
        this.#queries.readTurnRuntime(...parameters);

    readonly readCommandRuntime: SessionQueryRuntime["readCommandRuntime"] = (...parameters) =>
        this.#queries.readCommandRuntime(...parameters);

    readonly readAttempt: SessionQueryRuntime["readAttempt"] = (...parameters) =>
        this.#queries.readAttempt(...parameters);

    readonly readInteraction: SessionQueryRuntime["readInteraction"] = (...parameters) =>
        this.#queries.readInteraction(...parameters);

    readonly readInteractionRuntime: SessionQueryRuntime["readInteractionRuntime"] = (...parameters) =>
        this.#queries.readInteractionRuntime(...parameters);

    readonly readPendingInteractions: SessionQueryRuntime["readPendingInteractions"] = (...parameters) =>
        this.#queries.readPendingInteractions(...parameters);

    readonly listSessions: SessionQueryRuntime["listSessions"] = (...parameters) =>
        this.#queries.listSessions(...parameters);

    readonly readEvents: SessionQueryRuntime["readEvents"] = (...parameters) => this.#queries.readEvents(...parameters);

    readonly readMessages: SessionQueryRuntime["readMessages"] = (scope, sessionId, cursor, limit, signal) =>
        this.#queries.readMessages(scope, sessionId, cursor, limit, signal);

    readonly readToolCallDetail: SessionQueryRuntime["readToolCallDetail"] = (...parameters) =>
        this.#queries.readToolCallDetail(...parameters);

    readonly openEventStream: SessionEventStreamRuntime["openEventStream"] = (...parameters) =>
        this.#eventStreams.open(...parameters);

    readonly subscribeToLiveEvents = (
        ...parameters: Parameters<SessionEventStreams["subscribeLive"]>
    ): Promise<string> => this.#eventStreams.subscribeLive(...parameters);

    readonly unsubscribeFromLiveEvents = (subscriptionId: string): void =>
        this.#eventStreams.unsubscribeLive(subscriptionId);

    readonly waitForEvents: SessionEventStreamRuntime["waitForEvents"] = (...parameters) =>
        this.#eventStreams.wait(...parameters);

    readonly closeEventStreams = (): void => {
        this.#eventStreams.close();
    };

    readonly exportSession = async (
        _scope: ProjectScope,
        _sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionExport> => {
        signal.throwIfAborted();
        throw new SessionRuntimeError("session_history_not_retained", "This Session has no cloud export");
    };

    readonly importSession = async (
        _scope: ProjectScope,
        _exported: unknown,
        _targetBinding: CreateSessionBindingRequest,
        _now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        signal.throwIfAborted();
        throw new SessionRuntimeError("session_history_not_retained", "Cloud Session import is unavailable");
    };
}
