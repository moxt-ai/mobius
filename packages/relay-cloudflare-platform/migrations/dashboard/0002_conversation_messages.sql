CREATE TABLE platform_conversation_messages (
  message_id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  content TEXT NOT NULL,
  images_json TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, session_id, idempotency_key)
);

CREATE INDEX platform_conversation_messages_page
  ON platform_conversation_messages(project_id, session_id, created_at DESC, message_id DESC);
