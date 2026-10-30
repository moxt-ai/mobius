ALTER TABLE `recorded_session_events_v2` ADD `received_at` integer;--> statement-breakpoint
ALTER TABLE `recorded_turns` ADD `inactivity_deadline` integer;--> statement-breakpoint
CREATE INDEX `recorded_turns_inactivity_deadline` ON `recorded_turns` (`inactivity_deadline`);