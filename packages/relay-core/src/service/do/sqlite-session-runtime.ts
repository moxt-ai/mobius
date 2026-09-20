import type {
    CreateSessionBindingRequest,
    ProjectScope,
    SessionExport,
    SessionSummary,
} from "../../entity/do/session.ts";
import type {
    SessionArtifactRuntime,
    SessionCommandRuntime,
    SessionEventStreamRuntime,
    SessionQueryRuntime,
    SessionTransferRuntime,
} from "../../infra/session-runtime.ts";
import type { SessionRecoveryStorage } from "../../storage/do/session-recovery-storage.ts";
import type { SessionArchiveService } from "./session-archive-service.ts";
import type { SessionArtifactService } from "./session-artifact-service.ts";
import type { SessionCommandService } from "./session-command-service.ts";
import type { SessionEventProjector } from "./session-event-projector.ts";
import type { SessionEventStreams } from "./session-event-stream.ts";
import type { SessionInteractionService } from "./session-interaction-service.ts";
import type { SessionLifecycleService } from "./session-lifecycle-service.ts";
import type { SessionQueryService } from "./session-query-service.ts";
import type { SessionStateService } from "./session-state-service.ts";
import type { SessionTransferService } from "./session-transfer-service.ts";

export class SqliteSessionRuntime
    implements
        SessionCommandRuntime,
        SessionQueryRuntime,
        SessionArtifactRuntime,
        SessionEventStreamRuntime,
        SessionTransferRuntime
{
    readonly #archive: SessionArchiveService;
    readonly #recovery: SessionRecoveryStorage;
    readonly #artifacts: SessionArtifactService;
    readonly #commands: SessionCommandService;
    readonly #eventProjector: SessionEventProjector;
    readonly #eventStreams: SessionEventStreams;
    readonly #interactions: SessionInteractionService;
    readonly #lifecycle: SessionLifecycleService;
    readonly #queries: SessionQueryService;
    readonly #store: SessionStateService;
    readonly #transfer: SessionTransferService;

    constructor(cx: {
        readonly storages: { readonly recovery: SessionRecoveryStorage };
        readonly services: {
            readonly archive: SessionArchiveService;
            readonly artifacts: SessionArtifactService;
            readonly commands: SessionCommandService;
            readonly eventProjector: SessionEventProjector;
            readonly eventStreams: SessionEventStreams;
            readonly interactions: SessionInteractionService;
            readonly lifecycle: SessionLifecycleService;
            readonly queries: SessionQueryService;
            readonly state: SessionStateService;
            readonly transfers: SessionTransferService;
        };
    }) {
        this.#archive = cx.services.archive;
        this.#recovery = cx.storages.recovery;
        this.#eventProjector = cx.services.eventProjector;
        this.#store = cx.services.state;
        this.#artifacts = cx.services.artifacts;
        this.#lifecycle = cx.services.lifecycle;
        this.#queries = cx.services.queries;
        this.#eventStreams = cx.services.eventStreams;
        this.#interactions = cx.services.interactions;
        this.#commands = cx.services.commands;
        this.#transfer = cx.services.transfers;
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

    readonly createArtifactUpload: SessionArtifactRuntime["createArtifactUpload"] = (...parameters) =>
        this.#artifacts.createUpload(...parameters);

    readonly authorizeArtifactUpload: SessionArtifactRuntime["authorizeArtifactUpload"] = (...parameters) =>
        this.#artifacts.authorizeUpload(...parameters);

    readonly completeArtifactUpload: SessionArtifactRuntime["completeArtifactUpload"] = (...parameters) =>
        this.#artifacts.completeUpload(...parameters);

    readonly readArtifact: SessionArtifactRuntime["readArtifact"] = (...parameters) =>
        this.#artifacts.read(...parameters);

    readonly readArtifactContent: SessionArtifactRuntime["readArtifactContent"] = (...parameters) =>
        this.#artifacts.readContent(...parameters);

    readonly resolveArtifactResources: SessionArtifactRuntime["resolveArtifactResources"] = (...parameters) =>
        this.#artifacts.resolveResources(...parameters);

    readonly openEventStream: SessionEventStreamRuntime["openEventStream"] = (...parameters) =>
        this.#eventStreams.open(...parameters);

    readonly waitForEvents: SessionEventStreamRuntime["waitForEvents"] = (...parameters) =>
        this.#eventStreams.wait(...parameters);

    readonly closeEventStreams = (): void => {
        this.#eventStreams.close();
    };

    readonly runArchiveWork = async (scope: ProjectScope, sessionId: string, signal: AbortSignal): Promise<number> => {
        signal.throwIfAborted();
        this.#store.requireSessionRow(scope, sessionId, false);
        return await this.#archive.runWork(scope, sessionId, signal);
    };

    readonly exportSession = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionExport> => await this.#transfer.exportSession(scope, sessionId, signal, this.readNativeHistory);

    readonly importSession = async (
        scope: ProjectScope,
        exported: unknown,
        targetBinding: CreateSessionBindingRequest,
        cloudRetention: boolean,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> =>
        await this.#transfer.importSession(
            scope,
            exported,
            targetBinding,
            cloudRetention,
            now,
            signal,
            this.createSession,
        );

    readonly hasPendingArchiveWork = (scope: ProjectScope, sessionId: string): boolean =>
        this.#archive.hasPendingWork(scope, sessionId);
}
