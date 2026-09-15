import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorktreeEnvironment } from "./worktree/environment.ts";

const OUTPUT_LIMIT = 256_000;
const TEMPORARY_DEPLOYMENT_PROFILE = "mobius_temporary_preview";
const DIRECTORY_DATABASE_BINDING = "DIRECTORY_DATABASE";
const PLATFORM_DIRECTORY_DATABASE_BINDING = "PLATFORM_DIRECTORY_DATABASE";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const worktreeEnvironment = readWorktreeEnvironment();

interface WranglerTarget {
    readonly configDirectory: string;
    readonly migrationBindings: (environment: string | undefined) => readonly string[];
    readonly packageName: string;
}

const standaloneTarget: WranglerTarget = {
    configDirectory: resolve(repositoryRoot, "packages/relay-cloudflare-standalone"),
    migrationBindings: () => [DIRECTORY_DATABASE_BINDING],
    packageName: "@moxt-ai/mobius-relay-cloudflare-standalone",
};
const platformTarget: WranglerTarget = {
    configDirectory: resolve(repositoryRoot, "packages/relay-cloudflare-platform"),
    migrationBindings: (environment) => {
        switch (environment) {
            case undefined:
                return ["D1_SHARD_APAC_01", PLATFORM_DIRECTORY_DATABASE_BINDING];
            case "staging":
                return ["D1_SHARD_APAC_01", "D1_SHARD_WNAM_01", PLATFORM_DIRECTORY_DATABASE_BINDING];
            case "production":
                return [
                    "D1_SHARD_APAC_01",
                    "D1_SHARD_APAC_02",
                    "D1_SHARD_WNAM_01",
                    "D1_SHARD_WNAM_02",
                    PLATFORM_DIRECTORY_DATABASE_BINDING,
                ];
            default:
                throw new Error("Unsupported Platform migration environment");
        }
    },
    packageName: "@moxt-ai/mobius-relay-cloudflare-platform",
};
const platformConfigSuffix = "packages/relay-cloudflare-platform/wrangler.jsonc";

class CommandFailedError extends Error {
    readonly exitCode: number;

    constructor(exitCode: number) {
        super(`Command exited with status ${exitCode.toString()}`);
        this.exitCode = exitCode;
        this.name = "CommandFailedError";
    }
}

function appendOutput(current: string, chunk: string): string {
    const combined = current + chunk;
    return combined.length > OUTPUT_LIMIT ? combined.slice(combined.length - OUTPUT_LIMIT) : combined;
}

async function runPnpm(arguments_: readonly string[], signal: AbortSignal): Promise<string> {
    return await new Promise((resolve, reject) => {
        const child = spawn(pnpmCommand, [...arguments_], {
            cwd: repositoryRoot,
            env: process.env,
            signal,
            stdio: ["inherit", "pipe", "pipe"],
        });
        let output = "";

        child.stdout?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            process.stdout.write(text);
            output = appendOutput(output, text);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            process.stderr.write(text);
            output = appendOutput(output, text);
        });
        child.once("error", reject);
        child.once("close", (exitCode) => {
            if (exitCode === 0) {
                resolve(output);
                return;
            }
            reject(new CommandFailedError(exitCode ?? 1));
        });
    });
}

function hasArgument(arguments_: readonly string[], name: string): boolean {
    return arguments_.some((argument) => argument === name || argument.startsWith(`${name}=`));
}

function addLocalDevelopmentPort(arguments_: readonly string[]): readonly string[] {
    if (arguments_[0] !== "dev" || hasArgument(arguments_, "--remote") || hasArgument(arguments_, "--port")) {
        return arguments_;
    }

    const rawPort = process.env["MOBIUS_RELAY_PORT"] ?? worktreeEnvironment["MOBIUS_RELAY_PORT"];
    if (rawPort === undefined) {
        return arguments_;
    }
    if (!/^\d+$/.test(rawPort)) {
        throw new Error("MOBIUS_RELAY_PORT must be an integer TCP port");
    }
    const port = Number(rawPort);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("MOBIUS_RELAY_PORT must be between 1 and 65535");
    }
    return [...arguments_, "--port", rawPort];
}

function selectWranglerOptions(arguments_: readonly string[], names: readonly string[]): readonly string[] {
    const selected: string[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === undefined) {
            continue;
        }
        const exactName = names.find((name) => argument === name);
        if (exactName !== undefined) {
            selected.push(argument);
            const value = arguments_[index + 1];
            if (value !== undefined) {
                selected.push(value);
                index += 1;
            }
            continue;
        }
        if (names.some((name) => argument.startsWith(`${name}=`))) {
            selected.push(argument);
        }
    }
    return selected;
}

function targetsPlatform(arguments_: readonly string[]): boolean {
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === "--config") {
            const value = arguments_[index + 1];
            if (value?.replaceAll("\\", "/").endsWith(platformConfigSuffix)) {
                return true;
            }
        }
        if (
            argument?.startsWith("--config=") &&
            argument.slice("--config=".length).replaceAll("\\", "/").endsWith(platformConfigSuffix)
        ) {
            return true;
        }
    }
    return false;
}

function resolveConfigPath(value: string, target: WranglerTarget): string {
    if (isAbsolute(value)) {
        return value;
    }
    const repositoryPath = resolve(repositoryRoot, value);
    return existsSync(repositoryPath) ? repositoryPath : resolve(target.configDirectory, value);
}

function normalizeConfigPath(arguments_: readonly string[], target: WranglerTarget): readonly string[] {
    const normalized: string[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === undefined) {
            continue;
        }
        if (argument === "--config") {
            const value = arguments_[index + 1];
            if (value !== undefined) {
                normalized.push(argument, resolveConfigPath(value, target));
                index += 1;
                continue;
            }
        }
        if (argument.startsWith("--config=")) {
            normalized.push(`--config=${resolveConfigPath(argument.slice("--config=".length), target)}`);
            continue;
        }
        normalized.push(argument);
    }
    if (!hasArgument(normalized, "--config")) {
        normalized.push("--config", resolve(target.configDirectory, "wrangler.jsonc"));
    }
    return normalized;
}

async function applyD1Migrations(
    location: string,
    wranglerArguments: readonly string[],
    target: WranglerTarget,
    signal: AbortSignal,
): Promise<void> {
    const forwardedOptions = selectWranglerOptions(wranglerArguments, [
        "--config",
        "--env",
        "--persist-to",
        "--profile",
    ]);
    const temporaryOptions = hasArgument(wranglerArguments, "--temporary") ? ["--temporary"] : [];
    const environmentOptions = selectWranglerOptions(wranglerArguments, ["--env"]);
    const environment = environmentOptions[0]?.startsWith("--env=")
        ? environmentOptions[0].slice("--env=".length)
        : environmentOptions[1];
    for (const binding of target.migrationBindings(environment)) {
        await runPnpm(
            [
                "--filter",
                target.packageName,
                "exec",
                "wrangler",
                "d1",
                "migrations",
                "apply",
                binding,
                location,
                ...forwardedOptions,
                ...temporaryOptions,
            ],
            signal,
        );
    }
}

function isolateTemporaryDeployment(arguments_: readonly string[]): readonly string[] {
    if (!hasArgument(arguments_, "--temporary") || hasArgument(arguments_, "--profile")) {
        return arguments_;
    }

    return [...arguments_, "--profile", TEMPORARY_DEPLOYMENT_PROFILE];
}

function readWorkerUrl(output: string): string {
    const match = /https:\/\/[a-zA-Z0-9.-]+\.workers\.dev/.exec(output);
    return match === null ? "" : match[0];
}

function printConnectionInstructions(workerUrl: string): void {
    process.stdout.write("\nMobius deployment ready.\n");
    process.stdout.write(`Open the pairing page:\n${workerUrl}\n`);
    process.stdout.write("\nThe page creates a one-time command that pairs and starts the local daemon.\n");
}

async function run(signal: AbortSignal): Promise<void> {
    const isolatedArguments = isolateTemporaryDeployment(process.argv.slice(2));
    const target = targetsPlatform(isolatedArguments) ? platformTarget : standaloneTarget;
    const wranglerArguments = normalizeConfigPath(addLocalDevelopmentPort(isolatedArguments), target);
    const deployRequested = wranglerArguments[0] === "deploy";

    if (!deployRequested) {
        if (wranglerArguments[0] === "dev" && !hasArgument(wranglerArguments, "--remote")) {
            await applyD1Migrations("--local", wranglerArguments, target, signal);
        }
        await runPnpm(["--filter", target.packageName, "exec", "wrangler", ...wranglerArguments], signal);
        return;
    }

    const webPackage = target === platformTarget ? "@moxt-ai/mobius-platform-app" : "@moxt-ai/mobius-web";
    const environmentOptions = selectWranglerOptions(wranglerArguments, ["--env"]);
    const environment = environmentOptions[0]?.startsWith("--env=")
        ? environmentOptions[0].slice("--env=".length)
        : environmentOptions[1];
    const buildOptions = target === platformTarget ? ["--mode", environment ?? "development"] : [];
    await runPnpm(["--filter", webPackage, "build", ...buildOptions], signal);

    const temporaryDeployment = hasArgument(wranglerArguments, "--temporary");
    const dryRun = hasArgument(wranglerArguments, "--dry-run");
    const deploymentArguments = ["--filter", target.packageName, "exec", "wrangler", ...wranglerArguments];

    if (!dryRun && !temporaryDeployment) {
        await applyD1Migrations("--remote", wranglerArguments, target, signal);
    }

    if (
        target === platformTarget &&
        !temporaryDeployment &&
        (environment === "staging" || environment === "production")
    ) {
        const regionalDirectory = resolve(repositoryRoot, ".wrangler/regional", environment);
        await runPnpm(
            [
                "--filter",
                target.packageName,
                "exec",
                "node",
                "scripts/regional-workers.ts",
                "--template",
                resolve(target.configDirectory, "wrangler.regional.template.json"),
                "--config",
                resolve(target.configDirectory, "wrangler.jsonc"),
                "--env",
                environment,
                "--placement",
                resolve(target.configDirectory, "regional-placement.json"),
                "--output",
                regionalDirectory,
            ],
            signal,
        );
        for (const region of ["apac", "wnam"]) {
            await runPnpm(
                [
                    "--filter",
                    target.packageName,
                    "exec",
                    "wrangler",
                    "deploy",
                    "--config",
                    resolve(regionalDirectory, `${region}.json`),
                    ...(dryRun ? ["--dry-run"] : []),
                    ...selectWranglerOptions(wranglerArguments, ["--message", "--var", "--secrets-file"]),
                ],
                signal,
            );
        }
    }

    const output = await runPnpm(deploymentArguments, signal);
    if (dryRun) {
        process.stdout.write("\nMobius deployment dry-run completed.\n");
        return;
    }

    if (temporaryDeployment) {
        await applyD1Migrations("--remote", wranglerArguments, target, signal);
    }

    const workerUrl = readWorkerUrl(output);
    if (workerUrl.length === 0) {
        process.stdout.write(
            "\nDeployment completed, but Wrangler did not report a workers.dev URL. Configure the browser and daemon with the deployed custom domain.\n",
        );
        return;
    }

    printConnectionInstructions(workerUrl);
    if (temporaryDeployment) {
        process.stdout.write("\nClaim the temporary deployment within the deadline printed by Wrangler to keep it.\n");
    }
}

const controller = new AbortController();
const cancel = (): void => {
    controller.abort();
};
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

try {
    await run(controller.signal);
} catch (error) {
    if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : "Unknown failure";
        process.stderr.write(`Mobius deployment failed: ${message}\n`);
    }
    process.exitCode = error instanceof CommandFailedError ? error.exitCode : 1;
} finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
}
