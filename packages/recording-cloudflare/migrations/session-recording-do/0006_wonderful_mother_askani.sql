ALTER TABLE `recorded_session_events_v2` ADD `first_position` integer;--> statement-breakpoint
ALTER TABLE `recorded_session_events_v2` ADD `session_generation_id` text;--> statement-breakpoint
UPDATE `recorded_session_events_v2` SET
    `first_position` = json_extract(`envelope_json`, '$.events[0].position'),
    `session_generation_id` = json_extract(`envelope_json`, '$.events[0].sessionGenerationId')
WHERE `json_valid`(`envelope_json`) = 1;
