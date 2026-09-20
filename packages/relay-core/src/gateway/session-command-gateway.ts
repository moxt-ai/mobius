import type {
    Attempt,
    CommittedSessionEvent,
    InteractionResponse,
    NativeSessionHistory,
    PendingWork,
    SessionConfigureCommand,
    SessionEventEnvelope,
    SessionPromptCommand,
    Turn,
} from "@moxt-ai/mobius-protocol";
import type {
    AttemptReconciliationOutcome,
    CommittedEventResult,
    CreateSessionBindingRequest,
    CreateSessionRequest,
    InteractionResponseAcceptance,
    PendingDaemonDelivery,
    ProjectScope,
    SessionConfigurationAcceptance,
    SessionLifecycle,
    SessionSummary,
    TurnAcceptance,
    TurnCancellationAcceptance,
} from "../entity/do/session.ts";
export interface SessionCommandGateway {
    readonly acceptConfiguration: (
        scope: ProjectScope,
        runtimeId: string,
        command: SessionConfigureCommand,
        now: number,
        signal: AbortSignal,
    ) => Promise<SessionConfigurationAcceptance>;
    readonly acceptInteractionResponse: (
        scope: ProjectScope,
        sessionId: string,
        interactionId: string,
        responderId: string,
        response: InteractionResponse,
        deliveryPayload: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<InteractionResponseAcceptance>;
    readonly acceptTurn: (
        scope: ProjectScope,
        runtimeId: string,
        command: SessionPromptCommand,
        now: number,
        signal: AbortSignal,
    ) => Promise<TurnAcceptance>;
    readonly acceptTurnCancellation: (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        turnId: string,
        idempotencyKey: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<TurnCancellationAcceptance>;
    readonly promoteQueuedTurnToSteering: (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        turnId: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<Turn>;
    readonly setDefaultBinding: (
        scope: ProjectScope,
        sessionId: string,
        binding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ) => Promise<SessionSummary>;
    readonly commitEvent: (
        scope: ProjectScope,
        runtimeId: string,
        envelope: SessionEventEnvelope,
        now: number,
        signal: AbortSignal,
    ) => Promise<CommittedEventResult>;
    readonly createSession: (
        scope: ProjectScope,
        request: CreateSessionRequest,
        cloudRetention: boolean,
        now: number,
        signal: AbortSignal,
    ) => Promise<SessionSummary>;
    readonly deleteSession: (
        scope: ProjectScope,
        sessionId: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<SessionLifecycle>;
    readonly listPendingDaemonDeliveries: (
        scope: ProjectScope,
        runtimeId: string,
        limit: number,
        signal: AbortSignal,
    ) => Promise<readonly PendingDaemonDelivery[]>;
    readonly markPendingWorkCompleted: (
        scope: ProjectScope,
        sessionId: string,
        workId: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<PendingWork>;
    readonly markRuntimeDisconnected: (
        scope: ProjectScope,
        runtimeId: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<readonly CommittedSessionEvent[]>;
    readonly recordNativeHistory: (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        title: string,
        history: NativeSessionHistory,
        now: number,
        signal: AbortSignal,
    ) => Promise<SessionSummary>;
    readonly reconcileAttempt: (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        attemptId: string,
        outcome: AttemptReconciliationOutcome,
        now: number,
        signal: AbortSignal,
    ) => Promise<Attempt>;
}
