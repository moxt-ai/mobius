import type { SessionSummary } from "../entity/do/session.ts";

export interface SessionDirectoryGateway {
    readonly synchronizeSession: (summary: SessionSummary, signal: AbortSignal) => Promise<void>;
}
