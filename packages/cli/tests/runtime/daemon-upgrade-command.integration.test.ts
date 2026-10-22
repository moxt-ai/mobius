import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import cliPackage from "../../package.json" with { type: "json" };
import { sendLocalRequest } from "../../src/daemon/control/local-client.ts";
import { lifecycleResponse } from "../../src/daemon/control/protocol.ts";
import { openMobiusControlInstallation } from "../../src/daemon/pairing/pair-local-machine.ts";
import { findExecutableOnPath, runBoundedProcess } from "../../src/util/process/executable.ts";

// The npm registry stores real packed releases; the local registry serves them.
async function packedRelease(
    directory: string,
    version: string,
    broken: boolean,
    signal: AbortSignal,
): Promise<Buffer> {
    const root = join(directory, version);
    await mkdir(join(root, "dist"), { recursive: true });
    if (!broken) {
        const source = join(directory, `source-${version}`);
        await cp(resolve(import.meta.dirname, "../../src"), join(source, "src"), { recursive: true });
        await writeFile(join(source, "package.json"), JSON.stringify({ ...cliPackage, version }));
        await symlink(resolve(import.meta.dirname, "../../node_modules"), join(source, "node_modules"), "junction");
        await writeFile(
            join(root, "dist/cli.js"),
            `import ${JSON.stringify(pathToFileURL(join(source, "src/cli/entrypoint.ts")).href)};`,
        );
    } else {
        await writeFile(
            join(root, "dist/cli.js"),
            'console.log("Starting controlled release"); throw new Error("Controlled startup failure");',
        );
    }
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({
            name: cliPackage.name,
            version,
            type: "module",
            bin: { mobius: "dist/cli.js" },
            files: ["dist"],
        }),
    );
    const npm = await findExecutableOnPath("npm", process.env);
    if (npm === null) {
        throw new Error("npm is required by the upgrade scenario");
    }
    await runBoundedProcess({
        command: npm.path,
        arguments: ["pack", "--ignore-scripts", "--pack-destination", root],
        cwd: root,
        environment: process.env,
        signal,
        timeoutMilliseconds: 30_000,
    });
    return await readFile(join(root, `moxt-ai-mobius-${version}.tgz`));
}

describe("Mobius upgrade command", () => {
    it("Given a stopped daemon and a registry with newer releases, When the user runs mobius upgrade, Then the daemon starts, switches to the newest release, stays running on a repeat upgrade, and reports rollback for a broken release", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-upgrade-command-"));
        const signal = AbortSignal.timeout(240_000);
        const stateRoot = join(directory, "state");
        const environment = {
            ...process.env,
            MOBIUS_STATE_DIRECTORY: stateRoot,
            NPM_CONFIG_CACHE: join(directory, "npm-cache"),
        };
        const cli = async (
            arguments_: readonly string[],
        ): Promise<{
            readonly code: number | null;
            readonly stderr: string;
            readonly stdout: string;
        }> => {
            const child = spawn(
                process.execPath,
                [resolve(import.meta.dirname, "../../src/cli/entrypoint.ts"), ...arguments_],
                {
                    cwd: directory,
                    env: environment,
                    signal,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );
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
                child.once("close", (exitCode) => (exitCode === null ? reject(signal.reason) : resolve_(exitCode)));
            });
            return { code, stderr, stdout };
        };
        const good = "99.1.1";
        const bad = "99.1.3";
        let latest = good;
        const packages = new Map<string, Buffer>();
        let registryUrl = "";
        const server = createServer((request, response) => {
            const path = decodeURIComponent(request.url ?? "");
            if (path.startsWith("/@moxt-ai/mobius") && !path.endsWith(".tgz")) {
                const versions = Object.fromEntries(
                    [...packages].map(([version, bytes]) => [
                        version,
                        {
                            name: cliPackage.name,
                            version,
                            bin: { mobius: "dist/cli.js" },
                            dist: {
                                tarball: `${registryUrl}/${version}.tgz`,
                                integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                            },
                        },
                    ]),
                );
                response
                    .writeHead(200, { "content-type": "application/json" })
                    .end(JSON.stringify({ name: cliPackage.name, versions, "dist-tags": { latest } }));
            } else if (path.endsWith(".tgz")) {
                const bytes = packages.get(path.slice(1, -4));
                response.writeHead(bytes === undefined ? 404 : 200).end(bytes);
            } else {
                response.writeHead(404).end();
            }
        });
        try {
            packages.set(cliPackage.version, Buffer.from("not downloaded"));
            packages.set(good, await packedRelease(directory, good, false, signal));
            packages.set(bad, await packedRelease(directory, bad, true, signal));
            await new Promise<void>((resolve_) => server.listen(0, "127.0.0.1", resolve_));
            const address = server.address();
            if (address === null || typeof address === "string") {
                throw new Error("The registry did not listen");
            }
            registryUrl = `http://127.0.0.1:${address.port}`;
            Object.assign(environment, { NPM_CONFIG_REGISTRY: registryUrl });

            // The command starts the stopped daemon itself before upgrading it.
            const first = await cli(["upgrade"]);
            expect(first.code).toBe(0);
            expect(first.stdout).toContain(`Mobius daemon ${cliPackage.version} started`);
            expect(first.stdout).toContain(`Upgrading Mobius daemon to ${good}`);
            expect(first.stdout).toContain(`Mobius daemon upgraded to ${good}.`);

            const control = await openMobiusControlInstallation(signal, environment);
            const manager = await readFile(join(control.stateDirectory, "manager.lock"), "utf8");
            const workingVersion = async (): Promise<string> => {
                const response = lifecycleResponse.parse(
                    await sendLocalRequest(control.stateDirectory, "manager", { kind: "status" }, signal),
                );
                if (response.kind !== "status" || response.worker === null) {
                    throw new Error("The manager did not report a working daemon");
                }
                return response.worker.version;
            };
            expect(await workingVersion()).toBe(good);
            const upgradedWorker = await readFile(join(control.stateDirectory, "worker.lock"), "utf8");
            expect(await readFile(join(stateRoot, "current-data.txt"), "utf8")).toContain(`versions/${good}`);

            // A repeat upgrade keeps the newer running daemon instead of downgrading it.
            const repeat = await cli(["upgrade"]);
            expect(repeat.code).toBe(0);
            expect(repeat.stderr).toBe("");
            expect(repeat.stdout).toContain(`Mobius daemon ${good} is already the newest release.`);
            expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(upgradedWorker);
            expect(await readFile(join(control.stateDirectory, "manager.lock"), "utf8")).toBe(manager);

            // A broken newest release rolls back to the running daemon and fails the command.
            latest = bad;
            const failed = await cli(["upgrade"]);
            expect(failed.code).toBe(1);
            expect(failed.stderr).toContain("Mobius daemon failed:");
            expect(failed.stderr).toContain(`The upgrade to ${bad} failed and ${good} was restored`);
            expect(await workingVersion()).toBe(good);
            expect(await readFile(join(stateRoot, "current-data.txt"), "utf8")).toContain(`versions/${good}`);
            expect(await readFile(join(control.stateDirectory, "manager.lock"), "utf8")).toBe(manager);

            await cli(["quit"]);
            await expect(readFile(join(control.stateDirectory, "manager.lock"))).rejects.toMatchObject({
                code: "ENOENT",
            });
        } finally {
            await cli(["quit"]).catch(() => undefined);
            server.closeAllConnections();
            await new Promise<void>((resolve_) => server.close(() => resolve_()));
            await rm(directory, { recursive: true, force: true });
        }
    }, 270_000);
});
