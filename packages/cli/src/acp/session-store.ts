import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class AcpStoredSession {
  readonly additionalDirectories: readonly string[];
  readonly agentId: string;
  readonly cwd: string;
  readonly nativeSessionId: string;
  readonly prompted: boolean;
  readonly sessionId: string;

  constructor(
    sessionId: string,
    agentId: string,
    nativeSessionId: string,
    cwd: string,
    additionalDirectories: readonly string[],
    prompted: boolean,
  ) {
    this.additionalDirectories = [...additionalDirectories];
    this.agentId = agentId;
    this.cwd = cwd;
    this.nativeSessionId = nativeSessionId;
    this.prompted = prompted;
    this.sessionId = sessionId;
  }
}

export abstract class AcpStoredSessionLookup {
  abstract readonly found: boolean;
}

class MissingAcpStoredSession extends AcpStoredSessionLookup {
  readonly found = false;
}

export class FoundAcpStoredSession extends AcpStoredSessionLookup {
  readonly found = true;
  readonly session: AcpStoredSession;

  constructor(session: AcpStoredSession) {
    super();
    this.session = session;
  }
}

export interface AcpSessionStore {
  readonly read: (sessionId: string) => AcpStoredSessionLookup;
  readonly remove: (sessionId: string) => void;
  readonly write: (session: AcpStoredSession) => void;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Stored ACP session has an invalid ${field}`);
  }
  return value;
}

function readAdditionalDirectories(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    throw new Error("Stored ACP session has invalid additional directories");
  }
  const decoded: unknown = JSON.parse(value);
  if (
    !Array.isArray(decoded) ||
    decoded.some((directory) => typeof directory !== "string")
  ) {
    throw new Error("Stored ACP session has invalid additional directories");
  }
  return decoded;
}

function readPrompted(value: unknown): boolean {
  if (value === 0) {
    return false;
  }
  if (value === 1) {
    return true;
  }
  throw new Error("Stored ACP session has an invalid prompted state");
}

function decodeSessionRow(row: unknown): AcpStoredSession {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("Stored ACP session is not an object");
  }
  return new AcpStoredSession(
    readString(Reflect.get(row, "session_id"), "session ID"),
    readString(Reflect.get(row, "agent_id"), "agent ID"),
    readString(Reflect.get(row, "native_session_id"), "native session ID"),
    readString(Reflect.get(row, "cwd"), "working directory"),
    readAdditionalDirectories(Reflect.get(row, "additional_directories_json")),
    readPrompted(Reflect.get(row, "prompted")),
  );
}

export class MemoryAcpSessionStore implements AcpSessionStore {
  readonly #sessions = new Map<string, AcpStoredSession>();

  readonly read = (sessionId: string): AcpStoredSessionLookup => {
    const session = this.#sessions.get(sessionId);
    return session === undefined
      ? new MissingAcpStoredSession()
      : new FoundAcpStoredSession(session);
  };

  readonly remove = (sessionId: string): void => {
    this.#sessions.delete(sessionId);
  };

  readonly write = (session: AcpStoredSession): void => {
    this.#sessions.set(session.sessionId, session);
  };
}

export class SqliteAcpSessionStore implements AcpSessionStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS acp_sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        additional_directories_json TEXT NOT NULL,
        prompted INTEGER NOT NULL DEFAULT 0 CHECK (prompted IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT
    `);
    const columns = this.#database
      .prepare("PRAGMA table_info(acp_sessions)")
      .all();
    const hasPromptedColumn = columns.some(
      (column) =>
        typeof column === "object" &&
        column !== null &&
        Reflect.get(column, "name") === "prompted",
    );
    if (!hasPromptedColumn) {
      this.#database.exec(`
        ALTER TABLE acp_sessions
        ADD COLUMN prompted INTEGER NOT NULL DEFAULT 1 CHECK (prompted IN (0, 1))
      `);
    }
  }

  readonly read = (sessionId: string): AcpStoredSessionLookup => {
    const row = this.#database
      .prepare(
        `
          SELECT
            session_id,
            agent_id,
            native_session_id,
            cwd,
            additional_directories_json,
            prompted
          FROM acp_sessions
          WHERE session_id = ?
        `,
      )
      .get(sessionId);
    return row === undefined
      ? new MissingAcpStoredSession()
      : new FoundAcpStoredSession(decodeSessionRow(row));
  };

  readonly remove = (sessionId: string): void => {
    this.#database
      .prepare("DELETE FROM acp_sessions WHERE session_id = ?")
      .run(sessionId);
  };

  readonly write = (session: AcpStoredSession): void => {
    this.#database
      .prepare(
        `
          INSERT INTO acp_sessions (
            session_id,
            agent_id,
            native_session_id,
            cwd,
            additional_directories_json,
            prompted,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            agent_id = excluded.agent_id,
            native_session_id = excluded.native_session_id,
            cwd = excluded.cwd,
            additional_directories_json = excluded.additional_directories_json,
            prompted = excluded.prompted,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        session.sessionId,
        session.agentId,
        session.nativeSessionId,
        session.cwd,
        JSON.stringify(session.additionalDirectories),
        session.prompted ? 1 : 0,
        new Date().toISOString(),
      );
  };

  readonly close = (): void => {
    this.#database.close();
  };
}
