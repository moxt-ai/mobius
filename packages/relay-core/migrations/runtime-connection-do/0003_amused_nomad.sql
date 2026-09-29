CREATE TABLE `reliable_event_receipts` (
	`event_id` text PRIMARY KEY NOT NULL,
	`envelope_hash` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reliable_event_receipts_received` ON `reliable_event_receipts` (`received_at`,`event_id`);