import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "sqlite",
    out: "packages/recording-cloudflare/migrations/recording-directory-do",
    schema: "packages/recording-cloudflare/src/schema/recording-directory-do/*.ts",
});
