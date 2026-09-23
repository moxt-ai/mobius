import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay-cloudflare-platform/migrations/session-relay-do",
    schema: "packages/relay-cloudflare-platform/src/schema/session-relay-do/*.ts",
});
