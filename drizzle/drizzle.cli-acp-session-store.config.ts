import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/cli/migrations/acp-session-store",
    schema: "packages/cli/src/engine/schema/acp-session-store/index.ts",
});
