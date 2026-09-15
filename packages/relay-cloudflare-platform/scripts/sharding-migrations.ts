import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { unstable_readConfig } from "wrangler";

const { values } = parseArgs({
    options: {
        config: { type: "string" },
        env: { type: "string" },
        output: { type: "string" },
    },
});
const configPath = resolve(v.parse(v.string(), values.config));
const environment = v.parse(v.optional(v.picklist(["staging", "production"])), values.env);
const config = v.parse(
    v.object({
        name: v.string(),
        account_id: v.optional(v.string()),
        compatibility_date: v.string(),
        d1_databases: v.array(
            v.object({
                binding: v.string(),
                database_name: v.optional(v.string()),
                database_id: v.optional(v.string()),
            }),
        ),
    }),
    unstable_readConfig({ config: configPath, env: environment }),
);
await writeFile(
    resolve(v.parse(v.string(), values.output)),
    JSON.stringify({
        ...config,
        d1_databases: config.d1_databases
            .filter(({ binding }) => /^D1_SHARD_(APAC|WNAM)_0[12]$/u.test(binding))
            .map((database) => ({
                ...database,
                migrations_dir: fileURLToPath(new URL("../migrations/sharding", import.meta.url)),
                migrations_table: "platform_sharding_migrations",
            })),
    }),
);
