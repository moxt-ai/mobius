CREATE TABLE `platform_app_session_status_webhooks` (
	`app_id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`endpoint` text NOT NULL,
	`secret_id` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_nonce` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "platform_app_webhooks_enabled_check" CHECK("platform_app_session_status_webhooks"."enabled" in (0, 1))
);
