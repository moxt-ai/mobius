import type { Attempt, Interaction, NativeSessionHistory, Turn } from "@moxt-ai/mobius-protocol";
import type {
    ActivityDetail,
    ProjectScope,
    SessionConfigurationSnapshot,
    SessionDirectoryPage,
    SessionEventPage,
    SessionMessagePage,
    SessionSummary,
} from "../entity/do/session.ts";
export interface SessionQueryGateway {
    readonly readConfiguration: (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ) => Promise<SessionConfigurationSnapshot>;
    readonly listSessions: (
        scope: ProjectScope,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ) => Promise<SessionDirectoryPage>;
    readonly readAttempt: (
        scope: ProjectScope,
        sessionId: string,
        attemptId: string,
        signal: AbortSignal,
    ) => Promise<Attempt>;
    readonly readInteraction: (
        scope: ProjectScope,
        sessionId: string,
        interactionId: string,
        signal: AbortSignal,
    ) => Promise<Interaction>;
    readonly readInteractionRuntime: (
        scope: ProjectScope,
        sessionId: string,
        interactionId: string,
        signal: AbortSignal,
    ) => Promise<string>;
    readonly readPendingInteractions: (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ) => Promise<readonly Interaction[]>;
    readonly readSession: (scope: ProjectScope, sessionId: string, signal: AbortSignal) => Promise<SessionSummary>;
    readonly readTurn: (scope: ProjectScope, sessionId: string, turnId: string, signal: AbortSignal) => Promise<Turn>;
    readonly readTurnRuntime: (
        scope: ProjectScope,
        sessionId: string,
        turnId: string,
        signal: AbortSignal,
    ) => Promise<string>;
    readonly readCommandRuntime: (
        scope: ProjectScope,
        sessionId: string,
        commandId: string,
        signal: AbortSignal,
    ) => Promise<string>;
    readonly readToolCallDetail: (
        scope: ProjectScope,
        sessionId: string,
        attemptId: string,
        toolCallId: string,
        signal: AbortSignal,
    ) => Promise<ActivityDetail>;
    readonly readEvents: (
        scope: ProjectScope,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ) => Promise<SessionEventPage>;
    readonly readMessages: (
        scope: ProjectScope,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ) => Promise<SessionMessagePage>;
    readonly readNativeHistory: (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ) => Promise<NativeSessionHistory | null>;
}
