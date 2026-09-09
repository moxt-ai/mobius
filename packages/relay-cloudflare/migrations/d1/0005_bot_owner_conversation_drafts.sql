CREATE TABLE bot_owner_conversation_drafts (
  bot_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

INSERT INTO bot_owner_conversation_drafts (bot_id, conversation_id, created_at)
SELECT candidate.bot_id, candidate.conversation_id, candidate.created_at
  FROM bot_conversations AS candidate
 WHERE candidate.creator_kind = 'owner'
   AND candidate.lifecycle IN ('provisioning', 'active')
   AND NOT EXISTS (
     SELECT 1
       FROM bot_execution_directory AS executions
      WHERE executions.conversation_id = candidate.conversation_id
   )
   AND NOT EXISTS (
     SELECT 1
       FROM bot_conversations AS newer
      WHERE newer.bot_id = candidate.bot_id
        AND newer.creator_kind = 'owner'
        AND newer.lifecycle IN ('provisioning', 'active')
        AND NOT EXISTS (
          SELECT 1
            FROM bot_execution_directory AS newer_executions
           WHERE newer_executions.conversation_id = newer.conversation_id
        )
        AND (
          newer.created_at > candidate.created_at
          OR (
            newer.created_at = candidate.created_at
            AND newer.conversation_id > candidate.conversation_id
          )
        )
   );

CREATE TRIGGER bot_owner_conversation_draft_ownership
BEFORE INSERT ON bot_owner_conversation_drafts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM bot_conversations
     WHERE bot_id = NEW.bot_id
       AND conversation_id = NEW.conversation_id
       AND creator_kind = 'owner'
       AND lifecycle IN ('provisioning', 'active')
  ) THEN RAISE(ABORT, 'owner_conversation_draft_ownership') END;
END;
