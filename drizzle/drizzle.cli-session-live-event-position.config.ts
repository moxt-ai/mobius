import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

const configDirectory = import.meta.dirname;

export default defineConfig({
    dialect: "sqlite",
    out: resolve(configDirectory, "../packages/cli/migrations/session-live-event-position"),
    schema: resolve(configDirectory, "../packages/cli/src/schema/session-live-event-position/index.ts"),
});
