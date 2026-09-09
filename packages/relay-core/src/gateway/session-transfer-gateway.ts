import type { CreateSessionBindingRequest, ProjectScope, SessionExport, SessionSummary } from "../entity/do/session.ts";
export interface SessionTransferGateway {
    readonly exportSession: (scope: ProjectScope, sessionId: string, signal: AbortSignal) => Promise<SessionExport>;
    readonly importSession: (
        scope: ProjectScope,
        exported: unknown,
        targetBinding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ) => Promise<SessionSummary>;
}
