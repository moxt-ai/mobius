import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readWorktreeEnvironment } from "./worktree/environment.ts";

const OUTPUT_LIMIT = 256_000;
const TEMPORARY_DEPLOYMENT_PROFILE = "mobius_temporary_preview";
const DIRECTORY_DATABASE_BINDING = "DIRECTORY_DATABASE";
const CLOUDFLARE_RELAY_PACKAGE = "@moxt-ai/mobius-relay-cloudflare";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const worktreeEnvironment = readWorktreeEnvironment();

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
  return combined.length > OUTPUT_LIMIT
    ? combined.slice(combined.length - OUTPUT_LIMIT)
    : combined;
}

async function runPnpm(
  arguments_: readonly string[],
  signal: AbortSignal,
): Promise<string> {
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
  return arguments_.some(
    (argument) => argument === name || argument.startsWith(`${name}=`),
  );
}

function addLocalDevelopmentPort(
  arguments_: readonly string[],
): readonly string[] {
  if (
    arguments_[0] !== "dev" ||
    hasArgument(arguments_, "--remote") ||
    hasArgument(arguments_, "--port")
  ) {
    return arguments_;
  }

  const rawPort =
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for ProcessEnv.
    process.env["MOBIUS_RELAY_PORT"] ??
    // biome-ignore lint/complexity/useLiteralKeys: The readonly environment contract uses an index signature.
    worktreeEnvironment["MOBIUS_RELAY_PORT"];
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

function selectWranglerOptions(
  arguments_: readonly string[],
  names: readonly string[],
): readonly string[] {
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

async function applyD1Migrations(
  location: string,
  wranglerArguments: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const forwardedOptions = selectWranglerOptions(wranglerArguments, [
    "--config",
    "--env",
    "--persist-to",
    "--profile",
  ]);
  await runPnpm(
    [
      "--filter",
      CLOUDFLARE_RELAY_PACKAGE,
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      DIRECTORY_DATABASE_BINDING,
      location,
      ...forwardedOptions,
    ],
    signal,
  );
}

function isolateTemporaryDeployment(
  arguments_: readonly string[],
): readonly string[] {
  if (
    !hasArgument(arguments_, "--temporary") ||
    hasArgument(arguments_, "--profile")
  ) {
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
  process.stdout.write(
    "\nThe page creates a one-time command that pairs and starts the local daemon.\n",
  );
}

async function run(signal: AbortSignal): Promise<void> {
  const wranglerArguments = addLocalDevelopmentPort(
    isolateTemporaryDeployment(process.argv.slice(2)),
  );
  const deployRequested = wranglerArguments[0] === "deploy";

  if (!deployRequested) {
    if (
      wranglerArguments[0] === "dev" &&
      !hasArgument(wranglerArguments, "--remote")
    ) {
      await applyD1Migrations("--local", wranglerArguments, signal);
    }
    await runPnpm(
      [
        "--filter",
        CLOUDFLARE_RELAY_PACKAGE,
        "exec",
        "wrangler",
        ...wranglerArguments,
      ],
      signal,
    );
    return;
  }

  await runPnpm(["--filter", "@moxt-ai/mobius-web", "build"], signal);

  const temporaryDeployment = hasArgument(wranglerArguments, "--temporary");
  const dryRun = hasArgument(wranglerArguments, "--dry-run");
  const deploymentArguments = [
    "--filter",
    CLOUDFLARE_RELAY_PACKAGE,
    "exec",
    "wrangler",
    ...wranglerArguments,
  ];

  const output = await runPnpm(deploymentArguments, signal);
  if (dryRun) {
    process.stdout.write("\nMobius deployment dry-run completed.\n");
    return;
  }

  await applyD1Migrations("--remote", wranglerArguments, signal);

  const workerUrl = readWorkerUrl(output);
  if (workerUrl.length === 0) {
    process.stdout.write(
      "\nDeployment completed, but Wrangler did not report a workers.dev URL. Configure the browser and daemon with the deployed custom domain.\n",
    );
    return;
  }

  printConnectionInstructions(workerUrl);
  if (temporaryDeployment) {
    process.stdout.write(
      "\nClaim the temporary deployment within the deadline printed by Wrangler to keep it.\n",
    );
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
