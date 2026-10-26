import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { afterEach, describe, expect, it } from "vitest";

import cliPackage from "../../package.json" with { type: "json" };
import { openMobiusControlInstallation } from "../../src/daemon/pairing/pair-local-machine.ts";
import { packedRelease } from "../support/packed-daemon-release.ts";

const temporaryDirectories: string[] = [];
const sourceEntry = resolve(import.meta.dirname, "../../src/cli/entrypoint.ts");

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

interface CliResult {
    readonly code: number | null;
    readonly stderr: string;
    readonly stdout: string;
}

async function run(
    entry: string,
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<CliResult> {
    const child = spawn(process.execPath, [entry, ...arguments_], {
        env: environment,
        signal,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve_, reject) => {
        child.once("error", reject);
        child.once("exit", resolve_);
    });
    return { code, stderr, stdout };
}

// The CLI a user invokes after `npm install -g @moxt-ai/mobius`: an installed package whose bin is
// `dist/cli.js`, somewhere other than the state directory. It runs the source under test.
async function installGlobalCli(directory: string): Promise<string> {
    const packageRoot = join(directory, "global", "node_modules", "@moxt-ai", "mobius");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: cliPackage.name, type: "module" }));
    const entry = join(packageRoot, "dist", "cli.js");
    await writeFile(entry, `import ${JSON.stringify(pathToFileURL(sourceEntry).href)};\n`);
    return await realpath(entry);
}

interface Registry {
    readonly url: string;
    readonly close: () => Promise<void>;
}

// An npm registry that serves one real packed release of the source under test as the newest version.
async function serveRelease(directory: string, version: string, signal: AbortSignal): Promise<Registry> {
    const tarball = await packedRelease(directory, version, false, signal);
    let url = "";
    const server = createServer((request, response) => {
        const path = decodeURIComponent(request.url ?? "");
        if (path.startsWith("/@moxt-ai/mobius") && !path.endsWith(".tgz")) {
            response.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                    name: cliPackage.name,
                    versions: {
                        [version]: {
                            name: cliPackage.name,
                            version,
                            bin: { mobius: "dist/cli.js" },
                            dist: {
                                tarball: `${url}/${version}.tgz`,
                                integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
                            },
                        },
                    },
                    "dist-tags": { latest: version },
                }),
            );
        } else if (path === `/${version}.tgz`) {
            response.writeHead(200).end(tarball);
        } else {
            response.writeHead(404).end();
        }
    });
    await listen(server);
    url = `http://127.0.0.1:${port(server)}`;
    return {
        url,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve_) => server.close(() => resolve_()));
        },
    };
}

function isolatedEnvironment(directory: string, registryUrl: string): Readonly<NodeJS.ProcessEnv> {
    return {
        ...process.env,
        MOBIUS_STATE_DIRECTORY: join(directory, "state"),
        NPM_CONFIG_CACHE: join(directory, "npm-cache"),
        NPM_CONFIG_FETCH_RETRIES: "0",
        NPM_CONFIG_REGISTRY: registryUrl,
    };
}

// What `ps` shows for a process: the executable and the script it runs.
async function commandLine(processId: number): Promise<string> {
    const { stdout } = await promisify(execFile)("ps", ["-ww", "-o", "command=", "-p", String(processId)]);
    return stdout.trim();
}

async function daemonCommands(
    environment: Readonly<NodeJS.ProcessEnv>,
    signal: AbortSignal,
): Promise<{ readonly manager: string; readonly worker: string }> {
    const control = await openMobiusControlInstallation(signal, environment);
    const processId = async (role: "manager" | "worker"): Promise<number> =>
        Number(await readFile(join(control.stateDirectory, `${role}.lock`), "utf8"));
    return {
        manager: await commandLine(await processId("manager")),
        worker: await commandLine(await processId("worker")),
    };
}

async function managedRelease(directory: string, version: string): Promise<string> {
    return await realpath(
        join(directory, "state", "npm", version, "node_modules", "@moxt-ai", "mobius", "dist", "cli.js"),
    );
}

describe("Mobius daemon release location", () => {
    it("Given an installed CLI whose release is not yet in the state directory, When the user runs mobius start, Then npm installs that release and the daemon runs from it, and a later start needs no registry", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-release-location-"));
        temporaryDirectories.push(directory);
        const signal = AbortSignal.timeout(170_000);
        const version = cliPackage.version;
        const registry = await serveRelease(directory, version, signal);
        const environment = isolatedEnvironment(directory, registry.url);
        const globalCli = await installGlobalCli(directory);
        try {
            const first = await run(globalCli, ["start"], environment, signal);
            expect(first.code).toBe(0);
            expect(first.stdout).toContain(`Installing Mobius ${version}`);
            expect(first.stdout).toContain("Mobius daemon is running.\n");

            const managed = await managedRelease(directory, version);
            const firstCommands = await daemonCommands(environment, signal);
            expect(firstCommands.manager).toContain(`${managed} __manager`);
            expect(firstCommands.worker).toContain(`${managed} __worker`);
            expect(`${firstCommands.manager}\n${firstCommands.worker}`).not.toContain(globalCli);

            // The release now lives in the state directory: the registry is no longer needed.
            expect((await run(globalCli, ["quit"], environment, signal)).code).toBe(0);
            await registry.close();
            const second = await run(globalCli, ["start"], environment, signal);
            expect(second).toMatchObject({ code: 0, stderr: "" });
            expect(second.stdout).not.toContain("Installing");
            const secondCommands = await daemonCommands(environment, signal);
            expect(secondCommands.manager).toContain(`${managed} __manager`);
            expect(secondCommands.worker).toContain(`${managed} __worker`);
        } finally {
            await run(globalCli, ["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
            await registry.close();
        }
    }, 180_000);

    it("Given an installed CLI and a stopped daemon, When the user runs mobius upgrade, Then the daemon it starts runs from the same release location", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-release-upgrade-"));
        temporaryDirectories.push(directory);
        const signal = AbortSignal.timeout(170_000);
        const version = cliPackage.version;
        const registry = await serveRelease(directory, version, signal);
        const environment = isolatedEnvironment(directory, registry.url);
        const globalCli = await installGlobalCli(directory);
        try {
            const upgraded = await run(globalCli, ["upgrade"], environment, signal);
            expect(upgraded.code).toBe(0);
            expect(upgraded.stdout).toContain(`Mobius daemon ${version} is already the newest release.`);

            const managed = await managedRelease(directory, version);
            const commands = await daemonCommands(environment, signal);
            expect(commands.manager).toContain(`${managed} __manager`);
            expect(commands.worker).toContain(`${managed} __worker`);
        } finally {
            await run(globalCli, ["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
            await registry.close();
        }
    }, 180_000);

    it("Given an installed CLI and an unreachable npm registry, When the user runs mobius start, Then the daemon still runs, from the invoked CLI, and the CLI says why", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-release-offline-"));
        temporaryDirectories.push(directory);
        const signal = AbortSignal.timeout(110_000);
        const environment = isolatedEnvironment(directory, "http://127.0.0.1:1");
        const globalCli = await installGlobalCli(directory);
        try {
            const started = await run(globalCli, ["start"], environment, signal);
            expect(started.code).toBe(0);
            expect(started.stderr).toContain("npm_install_failed");
            expect(started.stdout).toContain("Mobius daemon is running.\n");

            const commands = await daemonCommands(environment, signal);
            expect(commands.manager).toContain(`${globalCli} __manager`);
            expect(commands.worker).toContain(`${globalCli} __worker`);
        } finally {
            await run(globalCli, ["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
        }
    }, 120_000);

    it("Given a source checkout, When the user runs mobius start, Then the daemon runs from the checkout and nothing is installed", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-release-checkout-"));
        temporaryDirectories.push(directory);
        const signal = AbortSignal.timeout(60_000);
        // A checkout has no release to install, so no registry is reachable or needed.
        const environment = isolatedEnvironment(directory, "http://127.0.0.1:1");
        const checkout = await realpath(sourceEntry);
        try {
            const started = await run(checkout, ["start"], environment, signal);
            expect(started).toMatchObject({ code: 0, stderr: "" });
            expect(started.stdout).not.toContain("Installing");

            const commands = await daemonCommands(environment, signal);
            expect(commands.manager).toContain(`${checkout} __manager`);
            expect(commands.worker).toContain(`${checkout} __worker`);
            await expect(stat(join(directory, "state", "npm"))).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await run(checkout, ["quit"], environment, AbortSignal.timeout(20_000)).catch(() => undefined);
        }
    }, 90_000);
});
