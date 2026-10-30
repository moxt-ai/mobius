-- Custom SQL migration file, put your code below! --
-- App deletion ends its Projects and AppCredentials in the same batch, and readers now consult only each entity's
-- own lifecycle. A Project or AppCredential created by a request that raced an earlier deletion could still be
-- active under a deleted App. End it at the App's deletion, never before it existed.
UPDATE `platform_projects`
   SET `lifecycle` = 'deleted',
       `deleted_at` = max(`created_at`, (
           SELECT coalesce(`apps`.`deleted_at`, `apps`.`updated_at`) FROM `platform_apps` AS `apps`
            WHERE `apps`.`app_id` = `platform_projects`.`app_id`)),
       `updated_at` = max(`created_at`, (
           SELECT coalesce(`apps`.`deleted_at`, `apps`.`updated_at`) FROM `platform_apps` AS `apps`
            WHERE `apps`.`app_id` = `platform_projects`.`app_id`))
 WHERE `lifecycle` = 'active'
   AND `app_id` IN (SELECT `app_id` FROM `platform_apps` WHERE `lifecycle` = 'deleted');
--> statement-breakpoint
UPDATE `platform_app_credentials`
   SET `revoked_at` = max(`issued_at`, (
           SELECT coalesce(`apps`.`deleted_at`, `apps`.`updated_at`) FROM `platform_apps` AS `apps`
            WHERE `apps`.`app_id` = `platform_app_credentials`.`app_id`))
 WHERE `revoked_at` IS NULL
   AND `app_id` IN (SELECT `app_id` FROM `platform_apps` WHERE `lifecycle` = 'deleted');
