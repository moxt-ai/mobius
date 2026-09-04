import type {
  AgentActivityEvent,
  AgentContentEvent,
  AgentDisplayContent,
  AgentMessageDeltaEvent,
  SessionCompletedEvent,
  SessionFailedEvent,
  SessionPromptCommand,
  SessionStartedEvent,
} from "@moxt-ai/mobius-protocol";
import {
  decodeAgentDisplayContentValue,
  decodePromptImagesValue,
  decodePromptResourcesValue,
} from "@moxt-ai/mobius-protocol";
import {
  type ChannelTurnStore,
  CompletedRecordedTurn,
  FailedRecordedTurn,
  PendingRecordedTurn,
  RecordedActivity,
  RecordedContent,
  type RecordedTurn,
  RunningRecordedTurn,
} from "@moxt-ai/mobius-relay-core";

const MAX_RECORDED_RESPONSE_LENGTH = 100_000;
const HISTORY_TURN_LIMIT = 500;

interface ConversationAgentRow extends Record<string, SqlStorageValue> {
  readonly agent_id: string;
}

interface HistoryTurnRow extends Record<string, SqlStorageValue> {
  readonly agent_id: string;
  readonly command_id: string;
  readonly created_at: number;
  readonly error_code: string;
  readonly error_message: string;
  readonly process_attempt_id: string;
  readonly prompt: string;
  readonly response: string;
  readonly session_id: string;
  readonly status: string;
  readonly stop_reason: string;
}

interface HistoryActivityRow extends Record<string, SqlStorageValue> {
  readonly activity_id: string;
  readonly activity_type: string;
  readonly command_id: string;
  readonly input_text: string;
  readonly locations_json: string;
  readonly name: string;
  readonly output_text: string;
  readonly sequence_number: number;
  readonly status: string;
  readonly title: string;
  readonly tool_kind: string;
}

interface TurnPayloadRow extends Record<string, SqlStorageValue> {
  readonly command_id: string;
  readonly images_json: string;
  readonly resources_json: string;
}

interface ActivityContentRow extends Record<string, SqlStorageValue> {
  readonly activity_id: string;
  readonly command_id: string;
  readonly content_json: string;
}

interface ContentRow extends Record<string, SqlStorageValue> {
  readonly command_id: string;
  readonly content_id: string;
  readonly content_json: string;
  readonly message_id: string;
}

function decodeLocations(encoded: string): readonly string[] {
  const value: unknown = JSON.parse(encoded);
  if (!Array.isArray(value)) {
    throw new Error("Invalid persisted activity locations");
  }
  const locations: string[] = [];
  for (const location of value) {
    if (typeof location !== "string") {
      throw new Error("Invalid persisted activity location");
    }
    locations.push(location);
  }
  return locations;
}

function decodeActivityContent(
  encoded: string,
): readonly AgentDisplayContent[] {
  const value: unknown = JSON.parse(encoded);
  if (!Array.isArray(value)) {
    throw new Error("Invalid persisted activity content");
  }
  return value.map((entry) => decodeAgentDisplayContentValue(entry));
}

export class DurableObjectTurnStore implements ChannelTurnStore {
  private readonly storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_conversations (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_turns (
      command_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      response TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      process_attempt_id TEXT NOT NULL DEFAULT '',
      stop_reason TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES channel_conversations(session_id)
    )`);
    this.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS channel_turns_session_id ON channel_turns(session_id, created_at)",
    );
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_turn_payloads (
      command_id TEXT PRIMARY KEY,
      images_json TEXT NOT NULL DEFAULT '[]',
      resources_json TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (command_id) REFERENCES channel_turns(command_id)
    )`);
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_contents (
      command_id TEXT NOT NULL,
      content_id TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (command_id, content_id),
      FOREIGN KEY (command_id) REFERENCES channel_turns(command_id)
    )`);
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_activities (
      command_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      activity_type TEXT NOT NULL CHECK (activity_type IN ('plan', 'progress', 'reasoning', 'tool')),
      input_text TEXT NOT NULL DEFAULT '',
      locations_json TEXT NOT NULL DEFAULT '[]',
      name TEXT NOT NULL DEFAULT '',
      output_text TEXT NOT NULL DEFAULT '',
      sequence_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      title TEXT NOT NULL,
      tool_kind TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (command_id, activity_id),
      FOREIGN KEY (command_id) REFERENCES channel_turns(command_id)
    )`);
    this.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS channel_activities_sequence ON channel_activities(command_id, sequence_number)",
    );
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_activity_content (
      command_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      content_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (command_id, activity_id),
      FOREIGN KEY (command_id, activity_id)
        REFERENCES channel_activities(command_id, activity_id)
    )`);
  }

  readonly appendDelta = (event: AgentMessageDeltaEvent, now: number): void => {
    const result = this.storage.sql.exec(
      `UPDATE channel_turns
       SET response = substr(response || ?, 1, ?), updated_at = ?
       WHERE command_id = ? AND session_id = ? AND status = 'running'`,
      event.text,
      MAX_RECORDED_RESPONSE_LENGTH,
      now,
      event.commandId,
      event.sessionId,
    );
    if (result.rowsWritten !== 1) {
      throw new Error("Unknown prompt delta");
    }
  };

  readonly complete = (event: SessionCompletedEvent, now: number): void => {
    const result = this.storage.sql.exec(
      `UPDATE channel_turns
       SET status = 'completed', stop_reason = ?, updated_at = ?
       WHERE command_id = ? AND session_id = ? AND status = 'running'`,
      event.stopReason,
      now,
      event.commandId,
      event.sessionId,
    );
    if (result.rowsWritten !== 1) {
      throw new Error("Unknown prompt completion");
    }
  };

  readonly fail = (event: SessionFailedEvent, now: number): void => {
    const result = this.storage.sql.exec(
      `UPDATE channel_turns
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
       WHERE command_id = ?
         AND session_id = ?
         AND status IN ('pending', 'running')`,
      event.code,
      event.message,
      now,
      event.commandId,
      event.sessionId,
    );
    if (result.rowsWritten !== 1) {
      throw new Error("Unknown prompt failure");
    }
  };

  readonly markStarted = (event: SessionStartedEvent, now: number): void => {
    const result = this.storage.sql.exec(
      `UPDATE channel_turns
       SET status = 'running', process_attempt_id = ?, updated_at = ?
       WHERE command_id = ? AND session_id = ? AND status = 'pending'`,
      event.processAttemptId,
      now,
      event.commandId,
      event.sessionId,
    );
    if (result.rowsWritten !== 1) {
      throw new Error("Unknown prompt start");
    }
  };

  readonly recordActivity = (event: AgentActivityEvent, now: number): void => {
    const turns = this.storage.sql
      .exec<{ readonly command_id: string }>(
        `SELECT command_id FROM channel_turns
         WHERE command_id = ? AND session_id = ? AND status = 'running'`,
        event.commandId,
        event.sessionId,
      )
      .toArray();
    if (turns.length !== 1) {
      throw new Error("Unknown prompt activity");
    }
    this.storage.sql.exec(
      `INSERT INTO channel_activities (
         command_id,
         activity_id,
         activity_type,
         input_text,
         locations_json,
         name,
         output_text,
         sequence_number,
         status,
         title,
         tool_kind,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(command_id, activity_id) DO UPDATE SET
         activity_type = excluded.activity_type,
         input_text = excluded.input_text,
         locations_json = excluded.locations_json,
         name = excluded.name,
         output_text = excluded.output_text,
         sequence_number = excluded.sequence_number,
         status = excluded.status,
         title = excluded.title,
         tool_kind = excluded.tool_kind,
         updated_at = excluded.updated_at`,
      event.commandId,
      event.activityId,
      event.activityType,
      event.input,
      JSON.stringify(event.locations),
      event.name,
      event.output,
      event.sequence,
      event.status,
      event.title,
      event.toolKind,
      now,
    );
    this.storage.sql.exec(
      `INSERT INTO channel_activity_content (
         command_id,
         activity_id,
         content_json
       ) VALUES (?, ?, ?)
       ON CONFLICT(command_id, activity_id) DO UPDATE SET
         content_json = excluded.content_json`,
      event.commandId,
      event.activityId,
      JSON.stringify(event.content),
    );
  };

  readonly recordContent = (event: AgentContentEvent, now: number): void => {
    const turns = this.storage.sql
      .exec<{ readonly command_id: string }>(
        `SELECT command_id FROM channel_turns
         WHERE command_id = ? AND session_id = ? AND status = 'running'`,
        event.commandId,
        event.sessionId,
      )
      .toArray();
    if (turns.length !== 1) {
      throw new Error("Unknown prompt content");
    }
    this.storage.sql.exec(
      `INSERT INTO channel_contents (
         command_id,
         content_id,
         message_id,
         content_json,
         updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(command_id, content_id) DO UPDATE SET
         message_id = excluded.message_id,
         content_json = excluded.content_json,
         updated_at = excluded.updated_at`,
      event.commandId,
      event.contentId,
      event.messageId,
      JSON.stringify(event.content),
      now,
    );
  };

  readonly readTurns = (): readonly RecordedTurn[] => {
    const rows = this.storage.sql
      .exec<HistoryTurnRow>(
        `SELECT
           conversations.agent_id,
           turns.command_id,
           turns.created_at,
           turns.error_code,
           turns.error_message,
           turns.process_attempt_id,
           turns.prompt,
           turns.response,
           turns.session_id,
           turns.status,
           turns.stop_reason
         FROM channel_turns AS turns
         INNER JOIN channel_conversations AS conversations
           ON conversations.session_id = turns.session_id
         ORDER BY conversations.created_at DESC, turns.created_at ASC
         LIMIT ?`,
        HISTORY_TURN_LIMIT,
      )
      .toArray();
    const payloads = new Map<string, TurnPayloadRow>();
    for (const row of this.storage.sql
      .exec<TurnPayloadRow>(
        `SELECT command_id, images_json, resources_json
         FROM channel_turn_payloads`,
      )
      .toArray()) {
      payloads.set(row.command_id, row);
    }
    const activitiesByCommand = new Map<string, RecordedActivity[]>();
    const commandIds = new Set(rows.map((row) => row.command_id));
    const activityRows = this.storage.sql
      .exec<HistoryActivityRow>(
        `SELECT
           activity_id,
           activity_type,
           command_id,
           input_text,
           locations_json,
           name,
           output_text,
           sequence_number,
           status,
           title,
           tool_kind
         FROM channel_activities
         ORDER BY command_id, sequence_number`,
      )
      .toArray();
    const activityContent = new Map<string, readonly AgentDisplayContent[]>();
    for (const row of this.storage.sql
      .exec<ActivityContentRow>(
        `SELECT command_id, activity_id, content_json
         FROM channel_activity_content`,
      )
      .toArray()) {
      activityContent.set(
        `${row.command_id}\0${row.activity_id}`,
        decodeActivityContent(row.content_json),
      );
    }
    const contentsByCommand = new Map<string, RecordedContent[]>();
    for (const row of this.storage.sql
      .exec<ContentRow>(
        `SELECT command_id, content_id, message_id, content_json
         FROM channel_contents
         ORDER BY updated_at`,
      )
      .toArray()) {
      if (!commandIds.has(row.command_id)) {
        continue;
      }
      const content = new RecordedContent(
        row.command_id,
        row.content_id,
        row.message_id,
        decodeAgentDisplayContentValue(JSON.parse(row.content_json)),
      );
      const contents = contentsByCommand.get(row.command_id);
      if (contents === undefined) {
        contentsByCommand.set(row.command_id, [content]);
      } else {
        contents.push(content);
      }
    }
    for (const row of activityRows) {
      if (!commandIds.has(row.command_id)) {
        continue;
      }
      const activity = new RecordedActivity(
        row.activity_id,
        row.activity_type,
        row.input_text,
        decodeLocations(row.locations_json),
        row.name,
        row.output_text,
        row.sequence_number,
        row.status,
        row.title,
        row.tool_kind,
        activityContent.get(`${row.command_id}\0${row.activity_id}`) ?? [],
      );
      const activities = activitiesByCommand.get(row.command_id);
      if (activities === undefined) {
        activitiesByCommand.set(row.command_id, [activity]);
      } else {
        activities.push(activity);
      }
    }
    const turns: RecordedTurn[] = [];
    for (const row of rows) {
      const createdAt = new Date(row.created_at).toISOString();
      const activities = activitiesByCommand.get(row.command_id) ?? [];
      const payload = payloads.get(row.command_id);
      const images =
        payload === undefined
          ? []
          : decodePromptImagesValue(JSON.parse(payload.images_json));
      const resources =
        payload === undefined
          ? []
          : decodePromptResourcesValue(JSON.parse(payload.resources_json));
      const contents = contentsByCommand.get(row.command_id) ?? [];
      if (row.status === "pending") {
        turns.push(
          new PendingRecordedTurn(
            row.agent_id,
            row.command_id,
            createdAt,
            row.prompt,
            row.response,
            row.session_id,
            activities,
            images,
            resources,
            contents,
          ),
        );
      } else if (row.status === "running") {
        turns.push(
          new RunningRecordedTurn(
            row.agent_id,
            row.command_id,
            createdAt,
            row.prompt,
            row.response,
            row.session_id,
            row.process_attempt_id,
            activities,
            images,
            resources,
            contents,
          ),
        );
      } else if (row.status === "completed") {
        turns.push(
          new CompletedRecordedTurn(
            row.agent_id,
            row.command_id,
            createdAt,
            row.prompt,
            row.response,
            row.session_id,
            row.process_attempt_id,
            row.stop_reason,
            activities,
            images,
            resources,
            contents,
          ),
        );
      } else if (row.status === "failed") {
        turns.push(
          new FailedRecordedTurn(
            row.agent_id,
            row.command_id,
            createdAt,
            row.prompt,
            row.response,
            row.session_id,
            row.error_code,
            row.error_message,
            activities,
            images,
            resources,
            contents,
          ),
        );
      } else {
        throw new Error("Invalid persisted turn status");
      }
    }
    return turns;
  };

  readonly recordPrompt = (
    command: SessionPromptCommand,
    now: number,
  ): void => {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT INTO channel_conversations (session_id, agent_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
        command.sessionId,
        command.agentId,
        now,
      );
      const conversations = this.storage.sql
        .exec<ConversationAgentRow>(
          "SELECT agent_id FROM channel_conversations WHERE session_id = ?",
          command.sessionId,
        )
        .toArray();
      const conversation = conversations[0];
      if (
        conversation === undefined ||
        conversation.agent_id !== command.agentId
      ) {
        throw new Error("Conversation agent mismatch");
      }
      this.storage.sql.exec(
        `INSERT INTO channel_turns (
           command_id,
           session_id,
           prompt,
           status,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, 'pending', ?, ?)`,
        command.commandId,
        command.sessionId,
        command.prompt,
        now,
        now,
      );
      this.storage.sql.exec(
        `INSERT INTO channel_turn_payloads (
           command_id,
           images_json,
           resources_json
         ) VALUES (?, ?, ?)`,
        command.commandId,
        JSON.stringify(command.images),
        JSON.stringify(command.resources),
      );
    });
  };
}
