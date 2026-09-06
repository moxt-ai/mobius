import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
const wranglerConfigPath = fileURLToPath(
  new URL("./wrangler.jsonc", import.meta.url),
);
const migrationsPath = fileURLToPath(
  new URL("./migrations/d1", import.meta.url),
);

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsPath);

  return {
    root: packageDirectory,
    plugins: [
      cloudflareTest({
        wrangler: { configPath: wranglerConfigPath },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["test/**/*.integration.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      testTimeout: 5_000,
    },
  };
});
