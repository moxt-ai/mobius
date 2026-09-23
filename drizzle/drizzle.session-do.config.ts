import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay-core/migrations/session-do",
    schema: "packages/relay-core/src/schema/session-do/*.ts",
});
