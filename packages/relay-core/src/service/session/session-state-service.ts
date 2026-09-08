import type { SessionRecord } from "../../entity/session/session-records.ts";
import type { SessionSqlDatabase } from "../../storage/session/session-sql-database.ts";
import { SessionStateStorage } from "../../storage/session/session-state-storage.ts";
import { rowNumber, rowString } from "../../storage/session/sqlite-row.ts";
import { type ProjectScope, type SessionQuotaPolicy, SessionRuntimeError } from "./session.ts";
import { scopeKey, validateDomainIdentifier } from "./session-records.ts";

export class SessionStateService {
    readonly #storage: SessionStateStorage;
    readonly #quota: SessionQuotaPolicy;

    constructor(database: SessionSqlDatabase, quota: SessionQuotaPolicy) {
        this.#storage = new SessionStateStorage(database);
        this.#quota = quota;
    }
    readonly assertSessionQuota = (scope: ProjectScope): void => {
        const tenant = this.#storage.countTenantSessions(scope.tenantId);
        const project = this.#storage.countProjectSessions(scope.tenantId, scope.projectId);
        if (tenant >= this.#quota.activeSessionsPerTenant || project >= this.#quota.activeSessionsPerProject) {
            throw new SessionRuntimeError(
                "session_quota_exceeded",
                "The tenant or project active session quota is exhausted",
            );
        }
    };

    readonly sessionRow = (scope: ProjectScope, sessionId: string): SessionRecord | null => {
        validateDomainIdentifier(sessionId, "session");
        return this.#storage.findSession(scopeKey(scope), sessionId) ?? null;
    };

    readonly requireSessionRow = (scope: ProjectScope, sessionId: string, activeOnly: boolean): SessionRecord => {
        const row = this.sessionRow(scope, sessionId);
        if (row === null) {
            throw new SessionRuntimeError("session_not_found", "The session does not exist");
        }
        if (activeOnly && rowString(row, "lifecycle") !== "ready") {
            throw new SessionRuntimeError("session_deleted", "The session is being deleted or has been deleted");
        }
        return row;
    };

    readonly requireActiveSessionRow = (scope: ProjectScope, sessionId: string, now: number): SessionRecord => {
        const row = this.requireSessionRow(scope, sessionId, true);
        const expiresAt = rowNumber(row, "updated_at") + rowNumber(row, "retention_milliseconds");
        if (now >= expiresAt) {
            this.#storage.markSessionDeleting({
                deleteRequestedAt: now,
                updatedAt: now,
                scopeKey: scopeKey(scope),
                sessionId: sessionId,
            });
            throw new SessionRuntimeError("session_deleted", "The session retention period has expired");
        }
        return row;
    };
}
