#!/usr/bin/env node

import { satisfies } from "semver";
import packageMetadata from "../../package.json" with { type: "json" };

// Check before loading the runtime graph, which may require newer Node APIs.
if (!satisfies(process.versions.node, packageMetadata.engines.node)) {
    process.stderr.write(
        `Mobius requires Node.js ${packageMetadata.engines.node}; found ${process.versions.node} at ${process.execPath}. Update Node.js and reinstall Mobius.\n`,
    );
    process.exitCode = 1;
} else {
    const { runCLI } = await import("./index.ts");
    await runCLI();
}
