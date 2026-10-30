const { execFileSync, spawnSync } = require("node:child_process");
const { appendFileSync, realpathSync } = require("node:fs");
const { normalize, relative } = require("node:path");

// Files outside the packages that change what a deployment job installs, generates, or runs.
const sharedInputs = [
    ".github/workflows/ci.yml",
    ".gitattributes",
    ".npmrc",
    ".nvmrc",
    "drizzle",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/ci-detect-worker-deployment.cjs",
    "scripts/generate-sql-modules.ts",
    "scripts/validate-worker-config.ts",
    "tsconfig.base.json",
    "tsconfig.json",
];

const environment = process.env.DEPLOY_ENVIRONMENT;
const eventName = process.env.EVENT_NAME;
// The name GitHub shows for the deploy job, which is also the name of its check runs.
const jobName = process.env.DEPLOY_JOB_NAME;
const repository = process.env.GITHUB_REPOSITORY;
const output = process.env.GITHUB_OUTPUT;
// The first package holds the Worker's Wrangler configuration; the others are built into its deployment.
const packages = process.argv.slice(2).map((directory) => normalize(directory).replace(/\/+$/, ""));
const worker = packages[0];
if (
    environment === undefined ||
    eventName === undefined ||
    jobName === undefined ||
    repository === undefined ||
    output === undefined ||
    worker === undefined
) {
    throw new Error("Required GitHub Actions inputs are unavailable");
}

const run = (command, args) =>
    execFileSync(command, args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "inherit"] });
const root = realpathSync(run("git", ["rev-parse", "--show-toplevel"]).trim());

/** The commit the environment runs, as recorded by `wrangler deploy --message` in this workflow. */
const liveCommit = () => {
    // Reading the deployment must never install dependencies, whose output would precede the JSON.
    const deployment = JSON.parse(
        run("pnpm", [
            "--config.verify-deps-before-run=false",
            "--dir",
            worker,
            "exec",
            "wrangler",
            "deployments",
            "status",
            "--config",
            "wrangler.jsonc",
            "--env",
            environment,
            "--json",
        ]),
    );
    const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
    if (versions.length !== 1 || versions[0]?.percentage !== 100) {
        throw new Error("the live deployment does not run a single version");
    }
    const message = deployment.annotations?.["workers/message"];
    const prefix = `GitHub ${repository}@`;
    const commit = typeof message === "string" && message.startsWith(prefix) ? message.slice(prefix.length) : "";
    if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
        throw new Error("the live deployment does not name the commit it was deployed from");
    }
    return commit;
};

const isAncestor = (ancestor, descendant) =>
    spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { timeout: 30_000 }).status === 0;

/** The latest run of this deploy job for a commit, from the commit's check runs. */
const latestDeployJob = (commit) => {
    const response = JSON.parse(
        run("gh", [
            "api",
            "--method",
            "GET",
            `repos/${repository}/commits/${commit}/check-runs`,
            "-f",
            `check_name=${jobName}`,
            "-f",
            "filter=all",
            "-f",
            "per_page=100",
        ]),
    );
    const checkRuns = Array.isArray(response?.check_runs) ? response.check_runs : [];
    if (response?.total_count !== checkRuns.length) {
        throw new Error(`GitHub listed ${checkRuns.length} of ${response?.total_count} "${jobName}" check runs`);
    }
    // Every attempt of a job is a new check run, so the highest identifier belongs to the latest attempt.
    return checkRuns
        .filter(
            (checkRun) =>
                checkRun?.name === jobName &&
                checkRun.app?.slug === "github-actions" &&
                Number.isSafeInteger(checkRun.id),
        )
        .reduce((latest, checkRun) => (latest === undefined || checkRun.id > latest.id ? checkRun : latest), undefined);
};

/** A package's directory and those of the workspace packages it depends on, including development ones. */
const packageInputs = (directory) => {
    const projects = JSON.parse(run("pnpm", ["--filter", `{${directory}}...`, "ls", "--depth", "-1", "--json"]));
    const directories = projects.map((project) => relative(root, realpathSync(project.path)));
    if (!directories.includes(directory)) {
        throw new Error(`pnpm did not select ${directory}`);
    }
    return directories;
};

const decide = () => {
    if (eventName === "workflow_dispatch") {
        return { deploy: true, reason: "a manual run always deploys" };
    }
    try {
        const commit = liveCommit();
        const live = `the live commit ${commit.slice(0, 12)}`;
        if (!isAncestor(commit, "HEAD")) {
            // Deploy jobs take an environment in the order their validation finishes, not in commit
            // order, so an earlier push's job can run after a later push deployed. Deploying it then
            // would roll the environment back.
            if (isAncestor("HEAD", commit)) {
                return {
                    deploy: false,
                    reason: `the environment already runs the later commit ${commit.slice(0, 12)}`,
                };
            }
            throw new Error(`the live commit ${commit} is not in the history of this commit`);
        }
        const inputs = [...new Set([...packages.flatMap(packageInputs), ...sharedInputs])];
        const changed = run("git", ["diff", "--no-renames", "--name-only", "-z", commit, "HEAD", "--", ...inputs])
            .split("\0")
            .filter((path) => path !== "");
        if (changed.length > 0) {
            const shown = changed.slice(0, 5).join(", ");
            const more = changed.length > 5 ? ` and ${changed.length - 5} more` : "";
            return { deploy: true, reason: `${shown}${more} changed since ${live}` };
        }
        // `wrangler deploy` activates the version before it publishes routes and custom domains, so the
        // live commit is a finished deployment only once its deploy job succeeded. While a re-run of that
        // job runs, it is the latest attempt, so the re-run deploys.
        const job = latestDeployJob(commit);
        if (job === undefined) {
            return { deploy: true, warning: true, reason: `no "${jobName}" job ran for ${live}` };
        }
        if (job.status !== "completed") {
            return { deploy: true, reason: `the latest "${jobName}" job for ${live} has not finished` };
        }
        if (job.conclusion !== "success") {
            return {
                deploy: true,
                warning: true,
                reason: `the latest "${jobName}" job for ${live} concluded ${job.conclusion}`,
            };
        }
        return { deploy: false, reason: `no input changed since ${live}, whose "${jobName}" job succeeded` };
    } catch (cause) {
        const detail = (cause instanceof Error ? cause.message : String(cause)).split("\n")[0];
        return { deploy: true, warning: true, reason: `the live version could not be checked (${detail})` };
    }
};

const decision = decide();
const summary = `${worker} (${environment}): ${decision.deploy ? "deploying" : "skipping the deployment"}; ${decision.reason}.`;
console.log(decision.warning ? `::warning::${summary}` : summary);
appendFileSync(output, `deploy=${String(decision.deploy)}\n`);
if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
