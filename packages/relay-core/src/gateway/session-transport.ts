import type { ProjectScope } from "../entity/do/session.ts";

export interface SessionTransport {
    readonly fetch: (
        target: {
            readonly cloudRetention: boolean;
            readonly runtimeId: string;
            readonly scope: ProjectScope;
            readonly sessionId: string;
        },
        request: Request,
    ) => Promise<Response>;
}
