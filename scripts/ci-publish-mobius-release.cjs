const { spawnSync } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const release = process.argv[2];
const runnerTemp = process.env.RUNNER_TEMP;
const definitions = {
    // The Protocol and SDK archives are packed by `ci-pack-mobius-releases.cjs` so their
    // `publishConfig` overrides (rewritten `workspace:*` dependencies) are applied before publish.
    protocol: { archiveName: "mobius-protocol.tgz" },
    sdk: { archiveName: "mobius-sdk.tgz" },
};
if (release !== "cli" && definitions[release] === undefined) {
    throw new Error("Expected a valid Mobius release target");
}

let archive;
let cwd;
if (release === "cli") {
    // `npm publish` does not apply every `publishConfig` override (it dropped `types`/`exports`),
    // so publishing the CLI straight from its directory ships the workspace-source `exports`. Pack
    // it with `pnpm pack`, which does apply `publishConfig`, and publish the resulting tarball.
    archive = resolve(mkdtempSync(join(tmpdir(), "mobius-cli-release-")), "mobius-cli.tgz");
    const packed = spawnSync("pnpm", ["--dir", "packages/cli", "pack", "--out", archive], {
        stdio: "inherit",
    });
    if (packed.error) {
        throw packed.error;
    }
    if (packed.status !== 0) {
        throw new Error(`pnpm pack exited with status ${packed.status}`);
    }
    cwd = "packages/cli";
} else {
    const definition = definitions[release];
    if (runnerTemp === undefined) {
        throw new Error("Runner temporary directory is unavailable");
    }
    archive = resolve(runnerTemp, definition.archiveName);
}

const args = ["publish", archive];
args.push("--access", "public");
const env = { ...process.env };
if (release !== "cli") {
    delete env.NODE_AUTH_TOKEN;
    delete env.NPM_CONFIG_USERCONFIG;
}
const result = spawnSync("npm", args, {
    ...(cwd === undefined ? {} : { cwd }),
    env,
    stdio: "inherit",
});
if (result.error) {
    throw result.error;
}
if (result.status !== 0) {
    throw new Error(`npm publish exited with status ${result.status}`);
}
