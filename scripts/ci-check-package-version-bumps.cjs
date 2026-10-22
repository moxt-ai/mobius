// A pull request that raises a published package's version must still be above
// the base it lands on. Two pull requests that raise a package to the same version
// merge without a conflict, and the publish workflow then skips the later one, so
// its changes are never released. Compare each raised version against the base.
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

const revision = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const baseRevision = process.env.BASE_SHA;
if (baseRevision === undefined || !revision.test(baseRevision)) {
    throw new Error("BASE_SHA must name the revision this change lands on");
}
// A merge queue names its branch gh-readonly-queue/<base>/pr-<number>-<head sha>.
const pullRequestHead =
    process.env.PULL_REQUEST_HEAD_SHA ||
    /\/pr-\d+-([0-9a-f]{40}|[0-9a-f]{64})$/.exec(process.env.MERGE_GROUP_REF ?? "")?.[1];
if (pullRequestHead === undefined || !revision.test(pullRequestHead)) {
    throw new Error("The pull request head revision is unavailable");
}

const packages = [
    { label: "CLI", manifest: "packages/cli/package.json" },
    { label: "SDK", manifest: "packages/mobius-sdk/package.json" },
];

const git = (args) => execFileSync("git", args, { encoding: "utf8", timeout: 30_000 }).trim();

const parseVersion = (text, source) => {
    const manifest = JSON.parse(text);
    if (manifest === null || typeof manifest !== "object" || typeof manifest.version !== "string") {
        throw new Error(`Package manifest at ${source} has no string version`);
    }
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.version);
    if (match === null) {
        throw new Error(`Version ${JSON.stringify(manifest.version)} at ${source} is not major.minor.patch`);
    }
    return { text: manifest.version, parts: match.slice(1).map(Number) };
};
const versionAt = (commit, manifest) => parseVersion(git(["show", `${commit}:${manifest}`]), `${commit}:${manifest}`);

const isAbove = (candidate, base) => {
    for (let index = 0; index < 3; index += 1) {
        if (candidate.parts[index] !== base.parts[index]) {
            return candidate.parts[index] > base.parts[index];
        }
    }
    return false;
};

const forkPoint = git(["merge-base", pullRequestHead, baseRevision]);
let unreleased = false;
for (const { label, manifest } of packages) {
    const branched = versionAt(forkPoint, manifest);
    const raised = versionAt(pullRequestHead, manifest);
    if (raised.text === branched.text) {
        console.log(`${label}: this pull request keeps version ${raised.text}; nothing new is published.`);
        continue;
    }
    const base = versionAt(baseRevision, manifest);
    const landing = parseVersion(readFileSync(manifest, "utf8"), manifest);
    if (isAbove(landing, base)) {
        console.log(`${label}: version ${landing.text} is above ${base.text} on the base and will be published.`);
        continue;
    }
    unreleased = true;
    console.error(
        [
            `${label}: this pull request raises the version from ${branched.text} to ${raised.text},`,
            `but the base already has ${base.text}, so the result would not be published.`,
            `Raise the version in ${manifest} above ${base.text}.`,
        ].join(" "),
    );
}
process.exit(unreleased ? 1 : 0);
