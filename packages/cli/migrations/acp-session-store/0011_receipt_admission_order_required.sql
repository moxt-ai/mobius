PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_execution_receipt` (
	`command_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`command_hash` text NOT NULL,
	`attempt_id` text NOT NULL,
	`admission_order` integer NOT NULL,
	`started` integer NOT NULL,
	`outcome` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_execution_receipt`("command_id", "session_id", "command_hash", "attempt_id", "admission_order", "started", "outcome", "updated_at") SELECT "command_id", "session_id", "command_hash", "attempt_id", "admission_order", "started", "outcome", "updated_at" FROM `execution_receipt`;--> statement-breakpoint
DROP TABLE `execution_receipt`;--> statement-breakpoint
ALTER TABLE `__new_execution_receipt` RENAME TO `execution_receipt`;--> statement-breakpoint
PRAGMA foreign_keys=ON;