-- Runtime pairing is the complete local trust establishment step. Bot bindings
-- become active when an owner selects an advertised Runtime, Agent, and
-- workspace; no daemon-local approval or grant exists after pairing.

DROP TRIGGER bot_conversation_active_binding;
DROP TRIGGER bot_binding_behavior_ownership;
DROP INDEX bot_execution_bindings_requested;
DROP INDEX bot_behavior_revisions_approved;

-- Normalize the one released catalog shape that carried the removed flag so
-- paired Runtimes remain readable without retaining approval compatibility in
-- application code.
UPDATE pairing_channels
   SET installable_agents_json = (
       SELECT COALESCE(
           json_group_array(json(
               CASE
                   WHEN json_type(entry.value, '$.requiresLocalApproval') IN ('true', 'false')
                     AND json_type(entry.value, '$.id') = 'text'
                     AND json_type(entry.value, '$.label') = 'text'
                     AND (SELECT COUNT(*) FROM json_each(entry.value)) = 3
                   THEN json_object(
                       'id', json_extract(entry.value, '$.id'),
                       'label', json_extract(entry.value, '$.label'),
                       'status', 'agent_not_installed'
                   )
                   ELSE entry.value
               END
           )),
           '[]'
       )
       FROM json_each(pairing_channels.installable_agents_json) AS entry
   )
 WHERE json_valid(installable_agents_json)
   AND EXISTS (
       SELECT 1
         FROM json_each(pairing_channels.installable_agents_json) AS entry
        WHERE json_type(entry.value, '$.requiresLocalApproval') IN ('true', 'false')
   );

-- A binding that was waiting for the removed daemon approval becomes the
-- current binding. Suspended Bots remain suspended and archived Bots remain
-- immutable.
UPDATE bots
   SET active_behavior_revision_id = (
           SELECT behavior_revision_id
             FROM bot_execution_bindings
            WHERE bot_id = bots.bot_id
              AND lifecycle = 'requested'
            ORDER BY binding_revision DESC
            LIMIT 1
       ),
       active_binding_id = (
           SELECT binding_id
             FROM bot_execution_bindings
            WHERE bot_id = bots.bot_id
              AND lifecycle = 'requested'
            ORDER BY binding_revision DESC
            LIMIT 1
       ),
       lifecycle = CASE WHEN lifecycle = 'suspended' THEN 'suspended' ELSE 'active' END,
       lifecycle_revision = lifecycle_revision + 1,
       updated_at = MAX(
           updated_at,
           COALESCE((
               SELECT created_at
                 FROM bot_execution_bindings
                WHERE bot_id = bots.bot_id
                  AND lifecycle = 'requested'
                ORDER BY binding_revision DESC
                LIMIT 1
           ), updated_at)
       )
 WHERE lifecycle <> 'archived'
   AND EXISTS (
       SELECT 1
         FROM bot_execution_bindings
        WHERE bot_id = bots.bot_id
          AND lifecycle = 'requested'
   );

ALTER TABLE bot_behavior_revisions RENAME TO bot_behavior_revisions_legacy;

CREATE TABLE bot_behavior_revisions (
  behavior_revision_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  instructions TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL,
  agent_configuration_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('proposed', 'active', 'retired')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  UNIQUE(bot_id, revision_number),
  UNIQUE(bot_id, behavior_revision_id)
);

INSERT INTO bot_behavior_revisions (
  behavior_revision_id,
  bot_id,
  revision_number,
  instructions,
  required_capabilities_json,
  agent_configuration_json,
  content_digest,
  lifecycle,
  created_at,
  activated_at,
  retired_at
)
SELECT
  behaviors.behavior_revision_id,
  behaviors.bot_id,
  behaviors.revision_number,
  behaviors.instructions,
  behaviors.required_capabilities_json,
  behaviors.agent_configuration_json,
  behaviors.content_digest,
  CASE
    WHEN bots.active_behavior_revision_id = behaviors.behavior_revision_id
      AND bots.lifecycle <> 'archived' THEN 'active'
    WHEN behaviors.lifecycle IN ('approved', 'retired') THEN 'retired'
    ELSE 'proposed'
  END,
  behaviors.created_at,
  CASE
    WHEN bots.active_behavior_revision_id = behaviors.behavior_revision_id
      AND bots.lifecycle <> 'archived'
      THEN COALESCE(behaviors.approved_at, behaviors.created_at)
    ELSE NULL
  END,
  CASE
    WHEN bots.active_behavior_revision_id = behaviors.behavior_revision_id
      AND bots.lifecycle <> 'archived' THEN NULL
    WHEN behaviors.lifecycle IN ('approved', 'retired')
      THEN COALESCE(behaviors.retired_at, behaviors.approved_at, behaviors.created_at)
    ELSE NULL
  END
FROM bot_behavior_revisions_legacy AS behaviors
INNER JOIN bots ON bots.bot_id = behaviors.bot_id;

DROP TABLE bot_behavior_revisions_legacy;

CREATE UNIQUE INDEX bot_behavior_revisions_active
  ON bot_behavior_revisions(bot_id)
  WHERE lifecycle = 'active';

ALTER TABLE bot_execution_bindings RENAME TO bot_execution_bindings_legacy;

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
  execution_configuration_json TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'unavailable', 'revoked')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  unavailable_at INTEGER,
  revoked_at INTEGER,
  unavailable_code TEXT,
  unavailable_message TEXT,
  UNIQUE(bot_id, binding_revision),
  UNIQUE(bot_id, binding_id)
);

INSERT INTO bot_execution_bindings (
  binding_id,
  bot_id,
  behavior_revision_id,
  binding_revision,
  runtime_id,
  agent_ref,
  workspace_ref,
  agent_config_revision,
  allowed_delivery_target_ids_json,
  completion_policy_json,
  execution_configuration_json,
  lifecycle,
  created_at,
  activated_at,
  unavailable_at,
  revoked_at,
  unavailable_code,
  unavailable_message
)
SELECT
  bindings.binding_id,
  bindings.bot_id,
  bindings.behavior_revision_id,
  bindings.binding_revision,
  bindings.runtime_id,
  bindings.agent_ref,
  bindings.workspace_ref,
  bindings.agent_config_revision,
  bindings.allowed_delivery_target_ids_json,
  bindings.completion_policy_json,
  bindings.execution_configuration_json,
  CASE
    WHEN bindings.lifecycle = 'approved' THEN 'active'
    WHEN bindings.lifecycle = 'requested'
      AND bots.active_binding_id = bindings.binding_id
      AND bots.lifecycle <> 'archived' THEN 'active'
    WHEN bindings.lifecycle = 'requested' THEN 'revoked'
    ELSE bindings.lifecycle
  END,
  bindings.created_at,
  CASE
    WHEN bindings.lifecycle = 'approved'
      OR (
        bindings.lifecycle = 'requested'
        AND bots.active_binding_id = bindings.binding_id
        AND bots.lifecycle <> 'archived'
      ) THEN COALESCE(bindings.approved_at, bindings.created_at)
    ELSE NULL
  END,
  bindings.unavailable_at,
  CASE
    WHEN bindings.lifecycle = 'requested'
      AND (
        bots.active_binding_id <> bindings.binding_id
        OR bots.active_binding_id IS NULL
        OR bots.lifecycle = 'archived'
      ) THEN COALESCE(bindings.revoked_at, bindings.created_at)
    ELSE bindings.revoked_at
  END,
  bindings.unavailable_code,
  bindings.unavailable_message
FROM bot_execution_bindings_legacy AS bindings
INNER JOIN bots ON bots.bot_id = bindings.bot_id;

DROP TABLE bot_execution_bindings_legacy;

CREATE TRIGGER bot_binding_behavior_ownership
BEFORE INSERT ON bot_execution_bindings
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM bot_behavior_revisions
    WHERE bot_id = NEW.bot_id
      AND behavior_revision_id = NEW.behavior_revision_id
  ) THEN RAISE(ABORT, 'binding_behavior_ownership') END);
END;

DELETE FROM bot_control_outbox
 WHERE message_kind = 'binding_approval';

ALTER TABLE bot_control_outbox RENAME TO bot_control_outbox_legacy;

CREATE TABLE bot_control_outbox (
  outbox_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  message_kind TEXT NOT NULL CHECK (message_kind = 'conversation_provisioning'),
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  failure_code TEXT,
  UNIQUE(subject_id, message_kind)
);

INSERT INTO bot_control_outbox (
  outbox_id,
  bot_id,
  subject_id,
  runtime_id,
  message_kind,
  payload,
  state,
  created_at,
  completed_at,
  failure_code
)
SELECT
  outbox_id,
  bot_id,
  subject_id,
  runtime_id,
  message_kind,
  payload,
  state,
  created_at,
  completed_at,
  failure_code
FROM bot_control_outbox_legacy;

DROP TABLE bot_control_outbox_legacy;

CREATE INDEX bot_control_outbox_runtime
  ON bot_control_outbox(runtime_id, state, created_at, outbox_id);

DELETE FROM bot_audit_events
 WHERE action = 'bot.binding.approved';

UPDATE bot_audit_events
   SET action = 'bot.binding.activated'
 WHERE action = 'bot.binding.requested';

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
      AND bindings.lifecycle = 'active'
  ) THEN RAISE(ABORT, 'conversation_active_binding') END);
END;
