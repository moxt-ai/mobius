CREATE TABLE bots (
  bot_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  current_profile_revision_id TEXT NOT NULL,
  active_behavior_revision_id TEXT,
  active_binding_id TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'suspended', 'archived')),
  lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  suspended_at INTEGER,
  archived_at INTEGER
);

CREATE INDEX bots_project
  ON bots(tenant_id, project_id, lifecycle, updated_at DESC, bot_id DESC);

CREATE TABLE bot_profile_revisions (
  profile_revision_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  display_name TEXT NOT NULL,
  avatar_ref TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(bot_id, revision_number),
  UNIQUE(bot_id, profile_revision_id)
);

CREATE TABLE bot_behavior_revisions (
  behavior_revision_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  instructions TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL,
  agent_configuration_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('proposed', 'awaiting_local_approval', 'approved', 'retired')),
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  retired_at INTEGER,
  UNIQUE(bot_id, revision_number),
  UNIQUE(bot_id, behavior_revision_id)
);

CREATE TABLE bot_execution_bindings (
  binding_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  behavior_revision_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  runtime_id TEXT NOT NULL,
  agent_ref TEXT NOT NULL,
  workspace_ref TEXT NOT NULL,
  agent_config_revision INTEGER NOT NULL CHECK (agent_config_revision > 0),
  allowed_delivery_target_ids_json TEXT NOT NULL,
  completion_policy_json TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('requested', 'approved', 'unavailable', 'revoked')),
  local_grant_id TEXT,
  agent_identity_digest TEXT,
  workspace_identity_digest TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  unavailable_at INTEGER,
  revoked_at INTEGER,
  unavailable_code TEXT,
  unavailable_message TEXT,
  UNIQUE(bot_id, binding_revision),
  UNIQUE(bot_id, binding_id)
);

CREATE UNIQUE INDEX bot_execution_bindings_requested
  ON bot_execution_bindings(bot_id)
  WHERE lifecycle = 'requested';

CREATE UNIQUE INDEX bot_behavior_revisions_approved
  ON bot_behavior_revisions(bot_id)
  WHERE lifecycle = 'approved';

CREATE TABLE bot_connection_grants (
  grant_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_connection_id TEXT
);

CREATE INDEX bot_connection_grants_bot
  ON bot_connection_grants(bot_id, created_at DESC);

CREATE TABLE bot_connections (
  connection_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  connector_principal_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'revoked')),
  lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision > 0),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER,
  source_grant_id TEXT NOT NULL UNIQUE
);

CREATE INDEX bot_connections_bot
  ON bot_connections(bot_id, lifecycle, created_at DESC);

CREATE TABLE bot_connection_credentials (
  credential_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER,
  replaced_by_credential_id TEXT
);

CREATE INDEX bot_connection_credentials_connection
  ON bot_connection_credentials(connection_id, revoked_at, expires_at);

CREATE TABLE bot_delivery_targets (
  delivery_target_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  outbound_policy_revision INTEGER NOT NULL CHECK (outbound_policy_revision >= 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'disabled')),
  lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision > 0),
  owner_approved INTEGER NOT NULL CHECK (owner_approved IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  UNIQUE(connection_id, alias),
  UNIQUE(bot_id, delivery_target_id)
);

CREATE INDEX bot_delivery_targets_connection
  ON bot_delivery_targets(connection_id, lifecycle, created_at);

CREATE TABLE bot_conversations (
  conversation_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  behavior_revision_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  session_id TEXT NOT NULL UNIQUE,
  creator_kind TEXT NOT NULL CHECK (creator_kind IN ('owner', 'connection')),
  creator_principal_id TEXT NOT NULL,
  creator_key TEXT NOT NULL,
  connection_id TEXT,
  reply_delivery_target_id TEXT,
  client_conversation_key TEXT NOT NULL,
  title TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('provisioning', 'active', 'closed')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  closed_at INTEGER,
  failure_code TEXT,
  UNIQUE(bot_id, creator_key, client_conversation_key)
);

CREATE INDEX bot_conversations_bot
  ON bot_conversations(bot_id, created_at DESC, conversation_id DESC);

CREATE TABLE bot_control_outbox (
  outbox_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  message_kind TEXT NOT NULL CHECK (message_kind IN ('binding_approval', 'conversation_provisioning')),
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  failure_code TEXT,
  UNIQUE(subject_id, message_kind)
);

CREATE INDEX bot_control_outbox_runtime
  ON bot_control_outbox(runtime_id, state, created_at, outbox_id);

CREATE TABLE bot_execution_directory (
  execution_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  behavior_revision_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  capability_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  UNIQUE(conversation_id, turn_id)
);

CREATE INDEX bot_execution_directory_session
  ON bot_execution_directory(session_id, created_at DESC);

CREATE TABLE bot_audit_events (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX bot_audit_events_bot
  ON bot_audit_events(tenant_id, project_id, bot_id, recorded_at DESC, audit_id DESC);

CREATE TRIGGER bot_binding_behavior_ownership
BEFORE INSERT ON bot_execution_bindings
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM bot_behavior_revisions
    WHERE bot_id = NEW.bot_id
      AND behavior_revision_id = NEW.behavior_revision_id
  ) THEN RAISE(ABORT, 'binding_behavior_ownership') END);
END;

CREATE TRIGGER bot_delivery_target_connection_ownership
BEFORE INSERT ON bot_delivery_targets
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM bot_connections
    WHERE bot_id = NEW.bot_id
      AND connection_id = NEW.connection_id
  ) THEN RAISE(ABORT, 'target_connection_ownership') END);
END;

CREATE TRIGGER bot_conversation_active_binding
BEFORE INSERT ON bot_conversations
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
      FROM bots
      INNER JOIN bot_execution_bindings AS bindings
        ON bindings.binding_id = bots.active_binding_id
       AND bindings.bot_id = bots.bot_id
       AND bindings.behavior_revision_id = bots.active_behavior_revision_id
    WHERE bots.bot_id = NEW.bot_id
      AND bots.lifecycle = 'active'
      AND bindings.binding_id = NEW.binding_id
      AND bindings.binding_revision = NEW.binding_revision
      AND bindings.behavior_revision_id = NEW.behavior_revision_id
      AND bindings.lifecycle = 'approved'
  ) THEN RAISE(ABORT, 'conversation_active_binding') END);
END;
