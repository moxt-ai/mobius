import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorktreeEnvironment } from "./worktree/environment.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const demoPackageDirectory = fileURLToPath(new URL("../packages/platform-demo-app/", import.meta.url));
const configPath = resolve(repositoryRoot, "packages/relay-cloudflare-platform/wrangler.demo.jsonc");
const persistencePath = resolve(demoPackageDirectory, ".demo-platform-state");
const runtimeStatePath = resolve(demoPackageDirectory, ".demo-runtime-state");
const demoWorkspace = resolve(demoPackageDirectory, "demo-workspace");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

class DevelopmentPorts {
    readonly api: number;
    readonly platform: number;
    readonly web: number;

    constructor(platform: number, web: number) {
        const api = platform + 1_000;
        if (api > 65_535 || new Set([platform, web, api]).size !== 3) {
            throw new Error("The Platform demo could not derive a unique API port");
        }
        this.platform = platform;
        this.web = web;
        this.api = api;
    }
}

class ProcessExit {
    readonly code: number;
    readonly name: string;

    constructor(name: string, code: number) {
        this.name = name;
        this.code = code;
    }
}

function configuredPort(name: string, fallback: number, environment: Readonly<Record<string, string>>): number {
    const value = process.env[name] ?? environment[name];
    if (value === undefined) {
        return fallback;
    }
    if (!/^\d+$/.test(value)) {
        throw new Error(`${name} must be an integer TCP port`);
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`${name} must be between 1 and 65535`);
    }
    return port;
}

function environmentFor(ports: DevelopmentPorts, developerToken: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        MOBIUS_DEMO_API_PORT: ports.api.toString(),
        MOBIUS_DEMO_DEVELOPER_TOKEN: developerToken,
        MOBIUS_DEMO_PLATFORM_ENDPOINT: `http://127.0.0.1:${ports.platform.toString()}`,
        MOBIUS_DEMO_RUNTIME_STATE_DIRECTORY: runtimeStatePath,
        MOBIUS_DEMO_WORKSPACE: demoWorkspace,
        MOBIUS_RELAY_PORT: ports.platform.toString(),
        MOBIUS_WEB_PORT: ports.web.toString(),
    };
}

async function runFinite(arguments_: readonly string[], environment: NodeJS.ProcessEnv): Promise<void> {
    const deadline = AbortSignal.timeout(120_000);
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(pnpmCommand, [...arguments_], {
            cwd: repositoryRoot,
            env: { ...environment, CI: "1" },
            signal: deadline,
            stdio: "inherit",
        });
        child.once("error", rejectPromise);
        child.once("close", (code) => {
            if (code === 0) {
                resolvePromise();
            } else {
                rejectPromise(new Error(`Command failed with exit code ${(code ?? 1).toString()}`));
            }
        });
    });
}

function startProcess(name: string, arguments_: readonly string[], environment: NodeJS.ProcessEnv): ChildProcess {
    const child = spawn(pnpmCommand, [...arguments_], {
        cwd: repositoryRoot,
        env: environment,
        stdio: "inherit",
    });
    child.once("error", (error) => {
        process.stderr.write(`${name} failed to start: ${error.message}\n`);
    });
    return child;
}

function completed(name: string, child: ChildProcess): Promise<ProcessExit> {
    return new Promise((resolvePromise) => {
        child.once("close", (code) => resolvePromise(new ProcessExit(name, code ?? 1)));
    });
}

async function main(): Promise<void> {
    const worktree = readWorktreeEnvironment();
    const ports = new DevelopmentPorts(
        configuredPort("MOBIUS_RELAY_PORT", 8787, worktree),
        configuredPort("MOBIUS_WEB_PORT", 5190, worktree),
    );
    const developerToken = randomBytes(32).toString("base64url");
    const environment = environmentFor(ports, developerToken);
    const browserOrigin = `http://127.0.0.1:${ports.web.toString()}`;
    await mkdir(persistencePath, { recursive: true });
    await mkdir(runtimeStatePath, { recursive: true });
    await mkdir(demoWorkspace, { recursive: true });

    for (const binding of ["DIRECTORY_DATABASE", "PLATFORM_DIRECTORY_DATABASE"]) {
        await runFinite(
            [
                "--filter",
                "@moxt-ai/mobius-relay-cloudflare-platform",
                "exec",
                "wrangler",
                "d1",
                "migrations",
                "apply",
                binding,
                "--local",
                "--config",
                configPath,
                "--persist-to",
                persistencePath,
            ],
            environment,
        );
    }

    const worker = startProcess(
        "Platform Worker",
        [
            "--filter",
            "@moxt-ai/mobius-relay-cloudflare-platform",
            "exec",
            "wrangler",
            "dev",
            "--config",
            configPath,
            "--ip",
            "127.0.0.1",
            "--port",
            ports.platform.toString(),
            "--persist-to",
            persistencePath,
            "--var",
            `MOBIUS_DEMO_ALLOWED_ORIGIN:${browserOrigin}`,
            "--var",
            `MOBIUS_DEMO_DEVELOPER_TOKEN:${developerToken}`,
        ],
        environment,
    );
    const api = startProcess(
        "Demo API",
        ["--filter", "@moxt-ai/mobius-platform-demo", "exec", "node", "src/server.ts"],
        environment,
    );
    const web = startProcess(
        "Demo Web",
        ["--filter", "@moxt-ai/mobius-platform-demo", "exec", "vite", "--config", "vite.config.ts"],
        environment,
    );
    const children = [worker, api, web];
    let shuttingDown = false;
    let signalRequested = false;
    const stop = (): void => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGTERM");
            }
        }
    };
    const stopFromSignal = (): void => {
        signalRequested = true;
        stop();
    };
    process.once("SIGINT", stopFromSignal);
    process.once("SIGTERM", stopFromSignal);

    process.stdout.write("\nMobius Platform demo is starting.\n");
    process.stdout.write(`Open ${browserOrigin}\n`);
    process.stdout.write(`Platform Worker: http://127.0.0.1:${ports.platform.toString()}\n`);
    process.stdout.write("Use Ctrl-C to stop every owned process.\n\n");

    const exitPromises = [completed("Platform Worker", worker), completed("Demo API", api), completed("Demo Web", web)];
    const first = await Promise.race(exitPromises);
    stop();
    await Promise.all(exitPromises);
    process.removeListener("SIGINT", stopFromSignal);
    process.removeListener("SIGTERM", stopFromSignal);
    if (!signalRequested && first.code !== 0) {
        process.stderr.write(`${first.name} exited with status ${first.code.toString()}\n`);
        process.exitCode = first.code;
    }
}

await main();
