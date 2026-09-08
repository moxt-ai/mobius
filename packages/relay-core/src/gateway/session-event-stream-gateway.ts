import type { ProjectScope } from "../service/session/session.ts";
export interface SessionEventStreamGateway {
    readonly openEventStream: (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        signal: AbortSignal,
    ) => Promise<Response>;
}
