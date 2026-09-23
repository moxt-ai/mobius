const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const release = process.argv[2];
const runnerTemp = process.env.RUNNER_TEMP;
const definitions = {
    cli: {
        cwd: "packages/cli",
        target: undefined,
    },
    protocol: {
        cwd: undefined,
        target: runnerTemp === undefined ? undefined : resolve(runnerTemp, "mobius-protocol.tgz"),
    },
    sdk: {
        cwd: undefined,
        target: runnerTemp === undefined ? undefined : resolve(runnerTemp, "mobius-sdk.tgz"),
    },
};
const definition = definitions[release];
if (definition === undefined || (release !== "cli" && definition.target === undefined)) {
    throw new Error("Expected a valid Mobius release target");
}

const args = ["publish"];
if (definition.target !== undefined) {
    args.push(definition.target);
}
args.push("--access", "public");
const env = { ...process.env };
if (release !== "cli") {
    delete env.NODE_AUTH_TOKEN;
    delete env.NPM_CONFIG_USERCONFIG;
}
const result = spawnSync("npm", args, {
    cwd: definition.cwd,
    env,
    stdio: "inherit",
});
if (result.error) {
    throw result.error;
}
if (result.status !== 0) {
    throw new Error(`npm publish exited with status ${result.status}`);
}
