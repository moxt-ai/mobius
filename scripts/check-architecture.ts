import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cruise, format, getAvailableTranspilers } from "dependency-cruiser";
import extractDepcruiseOptions from "dependency-cruiser/config-utl/extract-depcruise-options";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const typescript = getAvailableTranspilers().find((transpiler) => transpiler.name === "typescript");
if (typescript?.available !== true) {
    throw new Error(
        `Architecture analysis requires a compatible TypeScript parser (${typescript?.version ?? "unavailable"}); ` +
            `found ${typescript?.currentVersion ?? "none"}. Check dependency-cruiser's packageExtensions dependency.`,
    );
}

const sourceDirectories = globSync("packages/*/src").sort();
const sourceFiles = globSync("packages/*/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}").sort();
if (sourceFiles.length === 0) {
    throw new Error("Architecture analysis found no production source files in packages/*/src.");
}

const options = await extractDepcruiseOptions("./dependency-cruiser.config.cjs");
const { output } = await cruise(sourceDirectories, options);
if (typeof output === "string") {
    throw new Error("Architecture analysis requires the dependency graph, not a formatted report.");
}

const environmentIssues = output.summary.environment.issues ?? [];
if (environmentIssues.length > 0) {
    throw new Error(
        `Architecture analysis environment is incomplete:\n${environmentIssues.map((issue) => `${issue.name}: ${issue.description}`).join("\n")}`,
    );
}

const scannedSources = new Set(
    output.modules
        .filter((module) => !module.matchesDoNotFollow && !module.couldNotResolve)
        .map((module) => module.source),
);
const missingSources = sourceFiles.filter((source) => !scannedSources.has(source));
if (missingSources.length > 0) {
    throw new Error(
        `Architecture analysis skipped ${missingSources.length} production source files:\n${missingSources.join("\n")}`,
    );
}

console.log(
    `Architecture analysis covered all ${sourceFiles.length} source files in ${sourceDirectories.length} packages.`,
);
const report = await format(output, { outputType: "err-long" });
console.log(report.output);
process.exitCode = output.summary.error > 0 || output.summary.warn > 0 ? 1 : report.exitCode;
