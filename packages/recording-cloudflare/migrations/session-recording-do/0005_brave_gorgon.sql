ALTER TABLE `recorded_session_events_v2` ADD `last_position` integer;--> statement-breakpoint
UPDATE `recorded_session_events_v2` SET `last_position` = json_extract(`envelope_json`, '$.events[' || (json_array_length(`envelope_json`, '$.events') - 1) || '].position') WHERE json_valid(`envelope_json`) = 1;--> statement-breakpoint
CREATE INDEX `recorded_session_events_v2_last_position` ON `recorded_session_events_v2` (`last_position`);
