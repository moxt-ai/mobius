import type { ProjectScope } from "../entity/do/session.ts";
export interface SessionEventStreamGateway {
    readonly openEventStream: (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        signal: AbortSignal,
    ) => Promise<Response>;
}
