PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_platform_tenants` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`quotas_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_platform_tenants`("tenant_id", "display_name", "quotas_json", "created_at", "updated_at") SELECT "tenant_id", "display_name", "quotas_json", "created_at", "updated_at" FROM `platform_tenants`;--> statement-breakpoint
DROP TABLE `platform_tenants`;--> statement-breakpoint
ALTER TABLE `__new_platform_tenants` RENAME TO `platform_tenants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;