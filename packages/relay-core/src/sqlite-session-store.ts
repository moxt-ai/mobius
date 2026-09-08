import {
  type ProjectScope,
  type SessionQuotaPolicy,
  SessionRuntimeError,
} from "./session-runtime.ts";
import type {
  SessionSqlDatabase,
  SessionSqlRow,
} from "./session-sql-database.ts";
import { rowNumber, rowString } from "./sqlite-row.ts";
import {
  scopeKey,
  validateDomainIdentifier,
} from "./sqlite-session-records.ts";

export class SqliteSessionStore {
  readonly #database: SessionSqlDatabase;
  readonly #quota: SessionQuotaPolicy;

  constructor(database: SessionSqlDatabase, quota: SessionQuotaPolicy) {
    this.#database = database;
    this.#quota = quota;
  }
  readonly assertSessionQuota = (scope: ProjectScope): void => {
    const tenant = this.#database.query(
      `SELECT COUNT(*) AS active_sessions FROM sessions
       WHERE tenant_id = ? AND lifecycle <> 'deleted'`,
      [scope.tenantId],
    )[0];
    const project = this.#database.query(
      `SELECT COUNT(*) AS active_sessions FROM sessions
       WHERE tenant_id = ? AND project_id = ? AND lifecycle <> 'deleted'`,
      [scope.tenantId, scope.projectId],
    )[0];
    if (tenant === undefined || project === undefined) {
      throw new SessionRuntimeError(
        "session_storage_unavailable",
        "The session quota usage is unavailable",
      );
    }
    if (
      rowNumber(tenant, "active_sessions") >=
        this.#quota.activeSessionsPerTenant ||
      rowNumber(project, "active_sessions") >=
        this.#quota.activeSessionsPerProject
    ) {
      throw new SessionRuntimeError(
        "session_quota_exceeded",
        "The tenant or project active session quota is exhausted",
      );
    }
  };

  readonly sessionRow = (
    scope: ProjectScope,
    sessionId: string,
  ): SessionSqlRow | null => {
    validateDomainIdentifier(sessionId, "session");
    return (
      this.#database.query(
        `SELECT * FROM sessions
       WHERE scope_key = ? AND session_id = ?`,
        [scopeKey(scope), sessionId],
      )[0] ?? null
    );
  };

  readonly requireSessionRow = (
    scope: ProjectScope,
    sessionId: string,
    activeOnly: boolean,
  ): SessionSqlRow => {
    const row = this.sessionRow(scope, sessionId);
    if (row === null) {
      throw new SessionRuntimeError(
        "session_not_found",
        "The session does not exist",
      );
    }
    if (activeOnly && rowString(row, "lifecycle") !== "ready") {
      throw new SessionRuntimeError(
        "session_deleted",
        "The session is being deleted or has been deleted",
      );
    }
    return row;
  };

  readonly requireActiveSessionRow = (
    scope: ProjectScope,
    sessionId: string,
    now: number,
  ): SessionSqlRow => {
    const row = this.requireSessionRow(scope, sessionId, true);
    const expiresAt =
      rowNumber(row, "updated_at") + rowNumber(row, "retention_milliseconds");
    if (now >= expiresAt) {
      this.#database.run(
        `UPDATE sessions
         SET lifecycle = 'deleting', delete_requested_at = ?, updated_at = ?
         WHERE scope_key = ? AND session_id = ? AND lifecycle = 'ready'`,
        [now, now, scopeKey(scope), sessionId],
      );
      throw new SessionRuntimeError(
        "session_deleted",
        "The session retention period has expired",
      );
    }
    return row;
  };
}
