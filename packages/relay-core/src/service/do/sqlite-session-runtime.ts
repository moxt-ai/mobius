import type {
    CreateSessionBindingRequest,
    ProjectScope,
    SessionExport,
    SessionSummary,
} from "../../entity/do/session.ts";
import type {
    SessionArtifactGateway,
    SessionCommandGateway,
    SessionEventStreamGateway,
    SessionQueryGateway,
    SessionTransferGateway,
} from "../../gateway/index.ts";
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
        SessionCommandGateway,
        SessionQueryGateway,
        SessionArtifactGateway,
        SessionEventStreamGateway,
        SessionTransferGateway
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

    readonly createSession: SessionCommandGateway["createSession"] = (...parameters) =>
        this.#lifecycle.createSession(...parameters);

    readonly listRecoverySessions = () => this.#recovery.list();

    readonly readExecutionBinding = (scope: ProjectScope, sessionId: string, executionId: string): string =>
        this.#recovery.readExecutionBinding(scope, sessionId, executionId);

    readonly acceptTurn: SessionCommandGateway["acceptTurn"] = (...parameters) =>
        this.#commands.acceptTurn(...parameters);

    readonly acceptConfiguration: SessionCommandGateway["acceptConfiguration"] = (...parameters) =>
        this.#commands.acceptConfiguration(...parameters);

    readonly acceptTurnCancellation: SessionCommandGateway["acceptTurnCancellation"] = (...parameters) =>
        this.#commands.acceptTurnCancellation(...parameters);

    readonly promoteQueuedTurnToSteering: SessionCommandGateway["promoteQueuedTurnToSteering"] = (...parameters) =>
        this.#commands.promoteQueuedTurnToSteering(...parameters);

    readonly commitEvent: SessionCommandGateway["commitEvent"] = async (...parameters) => {
        const result = await this.#commands.commitEvent(...parameters);
        if (!result.duplicate) {
            this.#eventStreams.publish(parameters[0], result.committed);
        }
        return result;
    };

    readonly setDefaultBinding: SessionCommandGateway["setDefaultBinding"] = (...parameters) =>
        this.#commands.setDefaultBinding(...parameters);

    readonly recordNativeHistory: SessionCommandGateway["recordNativeHistory"] = (...parameters) =>
        this.#lifecycle.recordNativeHistory(...parameters);

    readonly acceptInteractionResponse: SessionCommandGateway["acceptInteractionResponse"] = (...parameters) =>
        this.#interactions.acceptInteractionResponse(...parameters);

    readonly listPendingDaemonDeliveries: SessionCommandGateway["listPendingDaemonDeliveries"] = (...parameters) =>
        this.#interactions.listPendingDaemonDeliveries(...parameters);

    readonly markPendingWorkCompleted: SessionCommandGateway["markPendingWorkCompleted"] = (...parameters) =>
        this.#interactions.markPendingWorkCompleted(...parameters);

    readonly reconcileAttempt: SessionCommandGateway["reconcileAttempt"] = (...parameters) =>
        this.#interactions.reconcileAttempt(...parameters);

    readonly markRuntimeDisconnected: SessionCommandGateway["markRuntimeDisconnected"] = (...parameters) =>
        this.#commands.markRuntimeDisconnected(...parameters);

    readonly deleteSession: SessionCommandGateway["deleteSession"] = (...parameters) =>
        this.#lifecycle.deleteSession(...parameters);

    readonly readSession: SessionQueryGateway["readSession"] = (...parameters) =>
        this.#queries.readSession(...parameters);

    readonly readConfiguration: SessionQueryGateway["readConfiguration"] = (...parameters) =>
        this.#queries.readConfiguration(...parameters);

    readonly readNativeHistory: SessionQueryGateway["readNativeHistory"] = (...parameters) =>
        this.#queries.readNativeHistory(...parameters);

    readonly readTurn: SessionQueryGateway["readTurn"] = (...parameters) => this.#queries.readTurn(...parameters);

    readonly readTurnRuntime: SessionQueryGateway["readTurnRuntime"] = (...parameters) =>
        this.#queries.readTurnRuntime(...parameters);

    readonly readCommandRuntime: SessionQueryGateway["readCommandRuntime"] = (...parameters) =>
        this.#queries.readCommandRuntime(...parameters);

    readonly readAttempt: SessionQueryGateway["readAttempt"] = (...parameters) =>
        this.#queries.readAttempt(...parameters);

    readonly readInteraction: SessionQueryGateway["readInteraction"] = (...parameters) =>
        this.#queries.readInteraction(...parameters);

    readonly readInteractionRuntime: SessionQueryGateway["readInteractionRuntime"] = (...parameters) =>
        this.#queries.readInteractionRuntime(...parameters);

    readonly readPendingInteractions: SessionQueryGateway["readPendingInteractions"] = (...parameters) =>
        this.#queries.readPendingInteractions(...parameters);

    readonly listSessions: SessionQueryGateway["listSessions"] = (...parameters) =>
        this.#queries.listSessions(...parameters);

    readonly readEvents: SessionQueryGateway["readEvents"] = (...parameters) => this.#queries.readEvents(...parameters);

    readonly readMessages: SessionQueryGateway["readMessages"] = (...parameters) =>
        this.#queries.readMessages(...parameters);

    readonly readToolCallDetail: SessionQueryGateway["readToolCallDetail"] = (...parameters) =>
        this.#queries.readToolCallDetail(...parameters);

    readonly createArtifactUpload: SessionArtifactGateway["createArtifactUpload"] = (...parameters) =>
        this.#artifacts.createUpload(...parameters);

    readonly authorizeArtifactUpload: SessionArtifactGateway["authorizeArtifactUpload"] = (...parameters) =>
        this.#artifacts.authorizeUpload(...parameters);

    readonly completeArtifactUpload: SessionArtifactGateway["completeArtifactUpload"] = (...parameters) =>
        this.#artifacts.completeUpload(...parameters);

    readonly readArtifact: SessionArtifactGateway["readArtifact"] = (...parameters) =>
        this.#artifacts.read(...parameters);

    readonly readArtifactContent: SessionArtifactGateway["readArtifactContent"] = (...parameters) =>
        this.#artifacts.readContent(...parameters);

    readonly resolveArtifactResources: SessionArtifactGateway["resolveArtifactResources"] = (...parameters) =>
        this.#artifacts.resolveResources(...parameters);

    readonly openEventStream: SessionEventStreamGateway["openEventStream"] = (...parameters) =>
        this.#eventStreams.open(...parameters);

    readonly waitForEvents: SessionEventStreamGateway["waitForEvents"] = (...parameters) =>
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
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> =>
        await this.#transfer.importSession(scope, exported, targetBinding, now, signal, this.createSession);

    readonly hasPendingArchiveWork = (scope: ProjectScope, sessionId: string): boolean =>
        this.#archive.hasPendingWork(scope, sessionId);
}
