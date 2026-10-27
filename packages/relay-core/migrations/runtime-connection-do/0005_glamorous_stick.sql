CREATE TABLE `native_session_forks` (
	`project_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`result_json` text,
	PRIMARY KEY(`project_id`, `operation_id`)
);
