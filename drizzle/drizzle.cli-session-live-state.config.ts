import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

const configDirectory = import.meta.dirname;

export default defineConfig({
    dialect: "sqlite",
    out: resolve(configDirectory, "../packages/cli/migrations/session-live-state"),
    schema: resolve(configDirectory, "../packages/cli/src/schema/session-live-state/index.ts"),
});
