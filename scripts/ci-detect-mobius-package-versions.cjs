const { execFileSync } = require("node:child_process");
const { appendFileSync, readFileSync } = require("node:fs");

const beforeRevision = process.env.BEFORE_SHA;
const eventName = process.env.EVENT_NAME;
const output = process.env.GITHUB_OUTPUT;
const manual = eventName === "workflow_dispatch";
if (output === undefined || eventName === undefined) {
    throw new Error("Required GitHub Actions inputs are unavailable");
}
if (!manual && (beforeRevision === undefined || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(beforeRevision))) {
    throw new Error("The previous commit is invalid");
}

const packages = [
    {
        label: "SDK",
        manifest: "packages/mobius-sdk/package.json",
        name: "@moxt-ai/mobius-sdk",
        output: "sdk",
    },
];

const parseVersion = (text, source, expectedName) => {
    const manifest = JSON.parse(text);
    if (
        manifest === null ||
        typeof manifest !== "object" ||
        Array.isArray(manifest) ||
        manifest.name !== expectedName ||
        typeof manifest.version !== "string"
    ) {
        throw new Error(`Package manifest at ${source} is invalid`);
    }
    return manifest.version;
};

const readCurrentVersion = ({ manifest, name }) => {
    const path = `${manifest}`;
    return parseVersion(readFileSync(path, "utf8"), path, name);
};

const readPreviousVersion = (manifest, name) =>
    parseVersion(
        execFileSync("git", ["show", `${beforeRevision}:${manifest}`], {
            encoding: "utf8",
            timeout: 30_000,
        }),
        manifest,
        name,
    );

for (const packageDefinition of packages) {
    const current = readCurrentVersion(packageDefinition);
    let previous = current;
    if (!manual) {
        previous = readPreviousVersion(packageDefinition.manifest, packageDefinition.name);
    }
    const changed = manual || previous !== current;
    console.log(
        manual
            ? `${packageDefinition.label} manual release selected at ${current}.`
            : changed
              ? `${packageDefinition.label} version changed from ${previous} to ${current}.`
              : `${packageDefinition.label} version remains ${current}; publication will be skipped.`,
    );
    appendFileSync(output, `${packageDefinition.output}_changed=${String(changed)}\n`);
}
