DROP TRIGGER IF EXISTS bot_binding_behavior_ownership;
DROP TRIGGER IF EXISTS bot_conversation_active_binding;
DROP TRIGGER IF EXISTS bot_delivery_target_connection_ownership;
DROP TRIGGER IF EXISTS bot_owner_conversation_draft_ownership;

DROP TABLE IF EXISTS bot_owner_conversation_drafts;
DROP TABLE IF EXISTS bot_execution_directory;
DROP TABLE IF EXISTS bot_control_outbox;
DROP TABLE IF EXISTS bot_conversations;
DROP TABLE IF EXISTS bot_delivery_targets;
DROP TABLE IF EXISTS bot_connection_credentials;
DROP TABLE IF EXISTS bot_connections;
DROP TABLE IF EXISTS bot_connection_grants;
DROP TABLE IF EXISTS bot_execution_bindings;
DROP TABLE IF EXISTS bot_behavior_revisions;
DROP TABLE IF EXISTS bot_profile_revisions;
DROP TABLE IF EXISTS bot_audit_events;
DROP TABLE IF EXISTS bots;
