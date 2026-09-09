import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DIRECTORY_DATABASE, env.TEST_MIGRATIONS);
