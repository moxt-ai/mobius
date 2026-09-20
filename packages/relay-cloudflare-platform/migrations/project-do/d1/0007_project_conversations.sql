ALTER TABLE bot_conversations
  ADD COLUMN client_reference TEXT NOT NULL DEFAULT '';

UPDATE bot_conversations
   SET client_reference = client_conversation_key
 WHERE client_reference = '';

CREATE INDEX bot_conversations_client_reference
  ON bot_conversations(bot_id, creator_kind, client_reference);
