import type { ProjectScope } from "../entity/do/session.ts";

export interface SessionTransport {
    readonly fetch: (scope: ProjectScope, sessionId: string, request: Request) => Promise<Response>;
}
