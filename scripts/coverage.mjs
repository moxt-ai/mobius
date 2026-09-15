import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import coverageLibrary from "istanbul-lib-coverage";
import reportLibrary from "istanbul-lib-report";
import reports from "istanbul-reports";

const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json")));
const { createCoverageMap } = coverageLibrary;
const { createContext } = reportLibrary;
const suites = [
    ["cli", ".", ["packages/cli/tests/", "--coverage.reportsDirectory=coverage/cli"]],
    ["sdk", ".", ["packages/mobius-sdk/tests/", "--coverage.reportsDirectory=coverage/sdk"]],
    [
        "integration",
        ".",
        [
            "--exclude=packages/cli/**",
            "--exclude=packages/mobius-sdk/**",
            "--exclude=e2e/**",
            "--coverage.reportsDirectory=coverage/integration",
        ],
    ],
    ["e2e", ".", ["e2e/", "--coverage.reportsDirectory=coverage/e2e"]],
    ["web", "packages/web", ["--config", "vitest.integration.config.ts"]],
    ["standalone", "packages/relay-cloudflare-standalone", ["--max-workers=1", "--no-isolate"]],
    ["platform", "packages/relay-cloudflare-platform", ["--max-workers=1", "--no-isolate"]],
];
const [mode, suiteName, ...extraArgs] = process.argv.slice(2);
if (
    extraArgs.length > 0 ||
    (mode !== undefined && mode !== "--suite" && mode !== "--merge-only") ||
    (mode === "--suite" ? !suites.some(([name]) => name === suiteName) : suiteName !== undefined)
) {
    throw new Error("Usage: coverage.mjs [--suite cli|sdk|integration|e2e|web|standalone|platform | --merge-only]");
}
const cancellation = new AbortController();
const interrupt = () => cancellation.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
    if (mode !== "--merge-only") {
        await rm(new URL(`../coverage/${mode === "--suite" ? `${suiteName}/` : ""}`, import.meta.url), {
            recursive: true,
            force: true,
        });
    }
    let failed = false;
    for (const [name, directory, args] of suites) {
        if (mode === "--merge-only" || (mode === "--suite" && name !== suiteName)) {
            continue;
        }
        const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(20 * 60 * 1000)]);
        const status = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [vitest, "run", "--coverage", ...args], {
                cwd: `${root}/${directory}`,
                stdio: "inherit",
                signal,
            });
            child.once("error", reject);
            child.once("exit", (code) => resolve(code));
        });
        failed ||= status !== 0;
    }
    if (mode !== "--suite") {
        const coverage = createCoverageMap({});
        for (const [name] of suites) {
            const report = await readFile(new URL(`../coverage/${name}/coverage-final.json`, import.meta.url), "utf8");
            const suite = createCoverageMap(JSON.parse(report));
            if (suite.files().length === 0) {
                throw new Error(`Empty coverage report: ${name}`);
            }
            coverage.merge(suite);
        }
        const context = createContext({ dir: `${root}/coverage`, coverageMap: coverage });
        for (const format of ["text-summary", "json-summary", "lcovonly", "html"]) {
            reports.create(format).execute(context);
        }
        const summary = coverage.getCoverageSummary();
        for (const metric of ["lines", "statements", "functions", "branches"]) {
            const { covered, total } = summary[metric];
            console.log(`${metric}: ${covered}/${total}; 100% is an advisory target`);
        }
    }
    if (failed) {
        process.exitCode = 1;
    }
} finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
}
