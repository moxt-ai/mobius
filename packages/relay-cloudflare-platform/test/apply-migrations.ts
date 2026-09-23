import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

if (env.TEST_PLATFORM_MIGRATIONS.length > 0) {
    await applyD1Migrations(env.PLATFORM_DIRECTORY_DATABASE, env.TEST_PLATFORM_MIGRATIONS);
}
