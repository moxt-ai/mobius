const { readFileSync } = require("node:fs");

const manifestPath = "packages/protocol/package.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.name !== "@moxt-ai/mobius-protocol" ||
    typeof manifest.version !== "string"
) {
    throw new Error(`Package manifest at ${manifestPath} is invalid`);
}

const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
const deadline = Date.now() + 5 * 60_000;

const run = async () => {
    let lastResult = "no response";
    while (Date.now() < deadline) {
        try {
            const response = await fetch(registryUrl, {
                signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
            });
            await response.body?.cancel();
            lastResult = `HTTP ${response.status}`;
            if (response.status === 200) {
                console.log(`${manifest.name}@${manifest.version} is available in npm.`);
                return;
            }
        } catch (error) {
            lastResult = error instanceof Error ? error.message : "request failed";
        }

        const remaining = deadline - Date.now();
        if (remaining > 0) {
            console.log(`Waiting for ${manifest.name}@${manifest.version} to become available in npm (${lastResult}).`);
            await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, remaining)));
        }
    }
    throw new Error(
        `${manifest.name}@${manifest.version} did not become available in npm within 5 minutes (last result: ${lastResult}).`,
    );
};

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
