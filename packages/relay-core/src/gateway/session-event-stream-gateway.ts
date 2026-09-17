import type { ProjectScope, SessionEventPage } from "../entity/do/session.ts";
export interface SessionEventStreamGateway {
    readonly openEventStream: (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        signal: AbortSignal,
    ) => Promise<Response>;
    readonly waitForEvents: (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        limit: number,
        waitMilliseconds: number,
        signal: AbortSignal,
    ) => Promise<SessionEventPage>;
}
