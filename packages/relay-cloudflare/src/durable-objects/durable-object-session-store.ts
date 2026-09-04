import {
  decodeSessionCommandsUpdatedEvent,
  decodeSessionElicitationRequestedEvent,
  decodeSessionPermissionRequestedEvent,
  decodeSessionReadyEvent,
  decodeSessionUsageUpdatedEvent,
  MOBIUS_PROTOCOL_VERSION,
  type SessionCommandsUpdatedEvent,
  type SessionConfigUpdatedEvent,
  type SessionElicitationRequestedEvent,
  type SessionElicitationResolvedEvent,
  type SessionInfoUpdatedEvent,
  type SessionPermissionRequestedEvent,
  type SessionPermissionResolvedEvent,
  type SessionReadyEvent,
  type SessionUsageUpdatedEvent,
} from "@moxt-ai/mobius-protocol";
import {
  type ChannelSessionStore,
  RecordedSession,
} from "@moxt-ai/mobius-relay-core";

interface SessionSnapshotRow extends Record<string, SqlStorageValue> {
  readonly snapshot_json: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEventArray<T>(
  value: unknown,
  decode: (encoded: string) => T,
): readonly T[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid persisted session event list");
  }
  return value.map((entry) => decode(JSON.stringify(entry)));
}

function decodeSnapshot(encoded: string): RecordedSession {
  const value: unknown = JSON.parse(encoded);
  if (!isRecord(value)) {
    throw new Error("Invalid persisted session snapshot");
  }
  const ready = decodeSessionReadyEvent(
    JSON.stringify({
      additionalDirectories: value["additionalDirectories"],
      agentId: value["agentId"],
      agentName: value["agentName"],
      agentVersion: value["agentVersion"],
      capabilities: value["capabilities"],
      commands: value["commands"],
      configOptions: value["configOptions"],
      directoryId: value["directoryId"],
      directoryLabel: value["directoryLabel"],
      kind: "session.ready",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: "history-snapshot",
      restored: value["restored"],
      sessionId: value["sessionId"],
    }),
  );
  const commands = decodeSessionCommandsUpdatedEvent(
    JSON.stringify({
      commands: value["commands"],
      kind: "session.commands.updated",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: ready.sessionId,
    }),
  ).commands;
  const usage = readEventArray(value["usage"], decodeSessionUsageUpdatedEvent);
  const permissions = readEventArray(
    value["pendingPermissions"],
    decodeSessionPermissionRequestedEvent,
  );
  const elicitations = readEventArray(
    value["pendingElicitations"],
    decodeSessionElicitationRequestedEvent,
  );
  const title = value["title"];
  const updatedAt = value["updatedAt"];
  if (typeof title !== "string" || typeof updatedAt !== "string") {
    throw new Error("Invalid persisted session information");
  }
  return new RecordedSession(
    ready,
    ready.configOptions,
    commands,
    title,
    updatedAt,
    usage,
    permissions,
    elicitations,
  );
}

export class DurableObjectSessionStore implements ChannelSessionStore {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_session_snapshots (
      session_id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  readonly readSessions = (): readonly RecordedSession[] =>
    this.#storage.sql
      .exec<SessionSnapshotRow>(
        `SELECT snapshot_json
         FROM channel_session_snapshots
         ORDER BY updated_at DESC`,
      )
      .toArray()
      .map((row) => decodeSnapshot(row.snapshot_json));

  readonly recordReady = (event: SessionReadyEvent): void => {
    const previous = this.find(event.sessionId);
    this.write(
      new RecordedSession(
        event,
        event.configOptions,
        event.commands.length > 0 ? event.commands : (previous?.commands ?? []),
        previous?.title ?? "",
        previous?.updatedAt ?? "",
        previous?.usage ?? [],
        previous?.pendingPermissions ?? [],
        previous?.pendingElicitations ?? [],
      ),
    );
  };

  readonly recordConfig = (event: SessionConfigUpdatedEvent): void => {
    const session = this.find(event.sessionId);
    if (session !== undefined) {
      this.write(session.withConfig(event.configOptions));
    }
  };

  readonly recordCommands = (event: SessionCommandsUpdatedEvent): void => {
    const session = this.find(event.sessionId);
    if (session !== undefined) {
      this.write(session.withCommands(event.commands));
    }
  };

  readonly recordInfo = (event: SessionInfoUpdatedEvent): void => {
    const session = this.find(event.sessionId);
    if (session !== undefined) {
      this.write(session.withInfo(event.title, event.updatedAt));
    }
  };

  readonly recordUsage = (event: SessionUsageUpdatedEvent): void => {
    const session = this.find(event.sessionId);
    if (session !== undefined) {
      this.write(session.withUsage(event));
    }
  };

  readonly recordPermission = (
    event: SessionPermissionRequestedEvent,
  ): void => {
    const session = this.find(event.sessionId);
    if (session !== undefined) {
      this.write(session.withPermission(event));
    }
  };

  readonly resolvePermission = (
    event: SessionPermissionResolvedEvent,
  ): void => {
    const session = this.find(event.sessionId);
    if (session !== undefined) {
      this.write(session.withoutPermission(event.interactionId));
    }
  };

  readonly recordElicitation = (
    event: SessionElicitationRequestedEvent,
  ): void => {
    const session = this.find(event.sessionId);
    if (session !== undefined) {
      this.write(session.withElicitation(event));
    }
  };

  readonly resolveElicitation = (
    event: SessionElicitationResolvedEvent,
  ): void => {
    const session = this.find(event.sessionId);
    if (session !== undefined) {
      this.write(session.resolveElicitation(event));
    }
  };

  readonly find = (sessionId: string) =>
    this.readSessions().find((session) => session.sessionId === sessionId);

  readonly write = (session: RecordedSession): void => {
    this.#storage.sql.exec(
      `INSERT INTO channel_session_snapshots (
         session_id,
         snapshot_json,
         updated_at
       ) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot_json = excluded.snapshot_json,
         updated_at = excluded.updated_at`,
      session.sessionId,
      JSON.stringify(session),
      Date.now(),
    );
  };
}
