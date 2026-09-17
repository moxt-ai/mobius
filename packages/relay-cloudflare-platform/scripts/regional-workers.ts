import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { unstable_readConfig } from "wrangler";

// Each product owns its regional override template. Placeholders occupy a complete JSON string
// value and are replaced with JSON-encoded values, never raw interpolated text.
const { values } = parseArgs({
    options: {
        config: { type: "string" },
        env: { type: "string" },
        placement: { type: "string" },
        output: { type: "string" },
        built: { type: "boolean" },
        template: { type: "string" },
    },
});
const environment = v.parse(v.picklist(["staging", "production"]), values.env);
const sourceConfigPath = resolve(v.parse(v.string(), values.config));
const deployment = values.built
    ? v.parse(
          v.object({ configPath: v.string() }),
          JSON.parse(await readFile(resolve(dirname(sourceConfigPath), ".wrangler/deploy/config.json"), "utf8")),
      )
    : null;
const configPath =
    deployment === null
        ? sourceConfigPath
        : resolve(dirname(sourceConfigPath), ".wrangler/deploy", deployment.configPath);
const placementPath = resolve(v.parse(v.string(), values.placement));
const output = resolve(v.parse(v.string(), values.output));
const template = await readFile(resolve(v.parse(v.string(), values.template)), "utf8");
JSON.parse(template);
const regionSchema = v.object({ apac: v.string(), wnam: v.string() });
const placements = v.parse(
    v.object({ staging: regionSchema, production: regionSchema }),
    JSON.parse(await readFile(placementPath, "utf8")),
);
const base = v.parse(
    v.object({
        name: v.string(),
        main: v.string(),
        account_id: v.optional(v.string()),
        compatibility_date: v.string(),
        compatibility_flags: v.array(v.string()),
        observability: v.optional(v.unknown()),
        limits: v.optional(v.unknown()),
        vars: v.record(v.string(), v.unknown()),
        kv_namespaces: v.array(v.unknown()),
        d1_databases: v.array(v.unknown()),
        r2_buckets: v.array(v.unknown()),
        secrets: v.optional(v.unknown()),
        queues: v.object({ producers: v.array(v.unknown()) }),
        durable_objects: v.object({
            bindings: v.array(
                v.looseObject({ name: v.string(), class_name: v.string(), script_name: v.optional(v.never()) }),
            ),
        }),
    }),
    unstable_readConfig({ config: configPath, ...(deployment === null ? { env: environment } : {}) }),
);
if (!base.name || !base.main) {
    throw new Error("Regional deployment requires a named Worker with a main entrypoint");
}
await mkdir(output, { recursive: true });
const entrypoint = resolve(output, "entry.ts");
await writeFile(entrypoint, `export { default } from ${JSON.stringify(resolve(dirname(configPath), base.main))};\n`);
for (const region of ["apac", "wnam"] satisfies readonly ("apac" | "wnam")[]) {
    const substitutions = new Map<string, unknown>(
        Object.entries({
            workerName: `${base.name}-${region}`,
            entrypoint,
            placementRegion: placements[environment][region],
            projectRegion: region,
        }),
    );
    const rendered = template.replace(/"<%%\s*([A-Za-z][A-Za-z0-9]*)\s*%%>"/g, (_placeholder, key: string) => {
        if (!substitutions.has(key)) {
            throw new Error(`Unknown regional template placeholder: ${key}`);
        }
        const encoded = JSON.stringify(substitutions.get(key));
        if (encoded === undefined) {
            throw new Error(`Missing regional template value: ${key}`);
        }
        return encoded;
    });
    if (rendered.includes("<%%") || rendered.includes("%%>")) {
        throw new Error("Unresolved regional template placeholder");
    }
    const overrides = v.parse(
        v.object({
            name: v.string(),
            main: v.string(),
            placement: v.object({ region: v.string() }),
            vars: v.object({ MOBIUS_WORKER_REGION: v.picklist(["apac", "wnam"]) }),
            workers_dev: v.literal(false),
            preview_urls: v.literal(false),
            keep_vars: v.boolean(),
        }),
        JSON.parse(rendered),
    );
    // The base schema deliberately excludes public routes, assets, router service
    // bindings, migrations, and queue consumers. Shared resource settings are inherited.
    const configuration = {
        ...base,
        ...overrides,
        vars: { ...base.vars, ...overrides.vars },
        durable_objects: {
            bindings: base.durable_objects.bindings.map((binding) => ({
                ...binding,
                script_name: base.name,
            })),
        },
    };
    await writeFile(resolve(output, `${region}.json`), `${JSON.stringify(configuration, null, 2)}\n`);
}
