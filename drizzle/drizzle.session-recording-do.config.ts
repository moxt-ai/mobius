import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/recording-cloudflare/migrations/session-recording-do",
    schema: "packages/recording-cloudflare/src/schema/session-recording-do/*.ts",
});
