CREATE TABLE `pending_directory_updates` (
	`ordinal` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operations_json` text NOT NULL,
	`events` integer NOT NULL
);
