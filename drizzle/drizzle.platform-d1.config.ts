import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/relay-cloudflare-platform/migrations/d1",
    schema: "packages/relay-cloudflare-platform/src/schema/d1/*.ts",
});
