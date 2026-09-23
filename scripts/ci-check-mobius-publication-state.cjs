const { appendFileSync, readFileSync } = require("node:fs");

const output = process.env.GITHUB_OUTPUT;
if (output === undefined) {
    throw new Error("GitHub output path is unavailable");
}

const packages = [
    {
        output: "protocol_exists",
        required: process.env.PROTOCOL_CHANGED === "true" || process.env.SDK_CHANGED === "true",
        manifest: "packages/protocol/package.json",
        name: "@moxt-ai/mobius-protocol",
    },
    {
        output: "sdk_exists",
        required: process.env.SDK_CHANGED === "true",
        manifest: "packages/mobius-sdk/package.json",
        name: "@moxt-ai/mobius-sdk",
    },
];

const run = async () => {
    for (const packageDefinition of packages) {
        if (!packageDefinition.required) {
            continue;
        }
        const manifest = JSON.parse(readFileSync(packageDefinition.manifest, "utf8"));
        if (
            manifest === null ||
            typeof manifest !== "object" ||
            Array.isArray(manifest) ||
            manifest.name !== packageDefinition.name ||
            typeof manifest.version !== "string"
        ) {
            throw new Error(`Package manifest at ${packageDefinition.manifest} is invalid`);
        }
        const response = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(packageDefinition.name)}/${encodeURIComponent(manifest.version)}`,
            { signal: AbortSignal.timeout(30_000) },
        );
        await response.body?.cancel();
        if (response.status !== 200 && response.status !== 404) {
            throw new Error(
                `npm registry returned HTTP ${response.status} for ${packageDefinition.name}@${manifest.version}`,
            );
        }
        const exists = response.status === 200;
        console.log(
            `${packageDefinition.name}@${manifest.version} is ${exists ? "already published" : "not yet published"}.`,
        );
        appendFileSync(output, `${packageDefinition.output}=${String(exists)}\n`);
    }
};

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
