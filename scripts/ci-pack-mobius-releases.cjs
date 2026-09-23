const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const runnerTemp = process.env.RUNNER_TEMP;
if (runnerTemp === undefined) {
    throw new Error("Runner temporary directory is unavailable");
}

const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${result.status}`);
    }
};

const releases = [
    {
        selected: process.env.PROTOCOL_CHANGED === "true" && process.env.PROTOCOL_EXISTS !== "true",
        directory: "packages/protocol",
        archive: resolve(runnerTemp, "mobius-protocol.tgz"),
    },
    {
        selected: process.env.SDK_CHANGED === "true" && process.env.SDK_EXISTS !== "true",
        directory: "packages/mobius-sdk",
        archive: resolve(runnerTemp, "mobius-sdk.tgz"),
    },
];

for (const release of releases) {
    if (!release.selected) {
        continue;
    }
    run("pnpm", ["--dir", release.directory, "pack", "--out", release.archive]);
    run("npm", ["publish", release.archive, "--access", "public", "--dry-run"]);
}
