import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay-cloudflare-platform/migrations/project-do",
    schema: "packages/relay-cloudflare-platform/src/schema/project-do/*.ts",
});
