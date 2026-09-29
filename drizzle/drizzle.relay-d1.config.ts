import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay-core/migrations/d1",
    schema: ["packages/relay-core/src/schema/d1/*.ts", "packages/relay-cloudflare-standalone/src/schema/d1/*.ts"],
});
