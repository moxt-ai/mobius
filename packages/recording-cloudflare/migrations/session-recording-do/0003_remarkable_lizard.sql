DROP INDEX `recorded_session_events_event_id_unique`;--> statement-breakpoint
DROP INDEX `recorded_session_events_stream_order`;--> statement-breakpoint
ALTER TABLE `recorded_session_events` DROP COLUMN `event_id`;--> statement-breakpoint
ALTER TABLE `recorded_session_events` DROP COLUMN `source_seq`;--> statement-breakpoint
ALTER TABLE `recorded_session_events` DROP COLUMN `stream_id`;