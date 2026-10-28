import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

const configDirectory = import.meta.dirname;

export default defineConfig({
    dialect: "sqlite",
    out: resolve(configDirectory, "../packages/cli/migrations/session-event-cache"),
    schema: resolve(configDirectory, "../packages/cli/src/engine/schema/session-event-cache/index.ts"),
});
