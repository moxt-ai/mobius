import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay-cloudflare-platform/migrations/non-cloud-retention-session-relay-do",
    schema: "packages/relay-cloudflare-platform/src/schema/non-cloud-retention-session-relay-do/*.ts",
});
