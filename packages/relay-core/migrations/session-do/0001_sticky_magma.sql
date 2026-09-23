DROP TABLE `archive_segments`;--> statement-breakpoint
DROP TABLE `archive_work`;--> statement-breakpoint
DROP TABLE `artifacts`;--> statement-breakpoint
DROP TABLE `immutable_content`;--> statement-breakpoint
DROP TABLE `session_content_chunks`;--> statement-breakpoint
DROP TABLE `session_events`;--> statement-breakpoint
DROP TABLE `session_message_chunks`;--> statement-breakpoint
DROP TABLE `session_messages`;--> statement-breakpoint
DROP TABLE `session_stream_blocks`;--> statement-breakpoint
DROP TABLE `session_stream_event_refs`;--> statement-breakpoint
DROP TABLE `session_streams`;--> statement-breakpoint
DROP TABLE `tool_call_narrations`;--> statement-breakpoint
DROP TABLE `tool_call_views`;--> statement-breakpoint
DROP TABLE `turn_content_views`;--> statement-breakpoint
DROP TABLE `turn_message_anchors`;--> statement-breakpoint
DROP TABLE `uploaded_artifacts`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `native_history_json`;