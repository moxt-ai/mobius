import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/cli/migrations/command-cancellation",
    schema: "packages/cli/src/engine/schema/command-cancellation/index.ts",
});
