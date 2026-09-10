import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DIRECTORY_DATABASE, env.TEST_PROJECT_MIGRATIONS);
if (env.TEST_PLATFORM_MIGRATIONS.length > 0) {
    await applyD1Migrations(env.PLATFORM_DIRECTORY_DATABASE, env.TEST_PLATFORM_MIGRATIONS);
}
