import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { unstable_getDurableObjectClassNameToUseSQLiteMap, unstable_readConfig } from "wrangler";

const bindingsSchema = v.array(v.object({ class_name: v.string(), name: v.string() }));

export function miniflareDurableObjects(configUrl: URL) {
    const path = fileURLToPath(configUrl);
    const config = unstable_readConfig({ config: path });
    const sqliteClasses = unstable_getDurableObjectClassNameToUseSQLiteMap(config.migrations, config.exports);
    return Object.fromEntries(
        v
            .parse(bindingsSchema, config.durable_objects.bindings)
            .map((binding) => [
                binding.name,
                { className: binding.class_name, useSQLite: sqliteClasses.get(binding.class_name) ?? false },
            ]),
    );
}
