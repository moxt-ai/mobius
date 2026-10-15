import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeDaemonToServiceMessage, type RuntimeUpgradeResult } from "@moxt-ai/mobius-protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import cliPackage from "../../package.json" with { type: "json" };
import { sendLocalRequest } from "../../src/daemon-local-control.ts";
import { openMobiusCliInstallation, openMobiusControlInstallation } from "../../src/pairing/pair-local-machine.ts";
import { findExecutableOnPath, runBoundedProcess } from "../../src/process/executable.ts";

// The npm registry stores real packed releases; the Relay stores catalogs and
// remains online across replacement processes. Neither replaces product code.
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
            `import ${JSON.stringify(pathToFileURL(join(source, "src/cli.ts")).href)};`,
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

describe("Daemon server-requested upgrade", () => {
    it("Given a paired managed daemon, When npm installs a release and then a broken release, Then it switches, rolls back, reports the error and blocks subsequent upgrades", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-upgrade-journey-"));
        const signal = AbortSignal.timeout(240_000);
        const stateRoot = join(directory, "state");
        const environment = {
            ...process.env,
            MOBIUS_STATE_DIRECTORY: stateRoot,
            NPM_CONFIG_CACHE: join(directory, "npm-cache"),
        };
        const cli = async (
            args: readonly string[],
            deadline = signal,
            entry = resolve(import.meta.dirname, "../../src/cli.ts"),
        ): Promise<void> => {
            const child = spawn(process.execPath, [entry, ...args], {
                cwd: directory,
                env: environment,
                signal: deadline,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (chunk: Buffer) => {
                output += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
                output += chunk.toString();
            });
            await new Promise<void>((resolve_, reject) => {
                child.once("error", reject);
                child.once("close", (code) => (code === 0 ? resolve_() : reject(new Error(`CLI failed: ${output}`))));
            });
        };
        const good = `${cliPackage.version}-good`;
        const bad = `${cliPackage.version}-broken`;
        const packages = new Map<string, Buffer>();
        const catalogs = new Map<string, string>();
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
                    .end(JSON.stringify({ name: cliPackage.name, versions, "dist-tags": { latest: good } }));
            } else if (path.endsWith(".tgz")) {
                const bytes = packages.get(path.slice(1, -4));
                response.writeHead(bytes === undefined ? 404 : 200).end(bytes);
            } else if (request.method === "PUT" && path.endsWith("/catalog")) {
                let body = "";
                request.setEncoding("utf8");
                request.on("data", (chunk: string) => {
                    body += chunk;
                });
                request.on("end", () => {
                    catalogs.set(path, body);
                    response.writeHead(204).end();
                });
            } else if (request.method === "GET" && catalogs.has(path)) {
                response.writeHead(200, { "content-type": "application/json" }).end(catalogs.get(path));
            } else {
                response.writeHead(404).end();
            }
        });
        const sockets = new WebSocketServer({ server });
        let current: WebSocket | undefined;
        const connected = Promise.withResolvers<void>();
        const results: RuntimeUpgradeResult[] = [];
        let waiter: PromiseWithResolvers<RuntimeUpgradeResult> | undefined;
        const aborted = (): void => {
            connected.reject(signal.reason);
            waiter?.reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
        sockets.on("connection", (socket) => {
            current = socket;
            socket.on("message", (data) => {
                const message = decodeDaemonToServiceMessage(data.toString());
                if (message.kind === "runtime.heartbeat") {
                    socket.send(JSON.stringify({ kind: "runtime.heartbeat.ack", heartbeatId: message.heartbeatId }));
                } else if (message.kind === "runtime.upgrade.result") {
                    if (waiter === undefined) {
                        results.push(message);
                    } else {
                        const pending = waiter;
                        waiter = undefined;
                        pending.resolve(message);
                    }
                }
            });
            socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
            connected.resolve();
        });
        const next = async (): Promise<RuntimeUpgradeResult> => {
            signal.throwIfAborted();
            const result = results.shift();
            if (result !== undefined) {
                return result;
            }
            waiter = Promise.withResolvers<RuntimeUpgradeResult>();
            return await waiter.promise;
        };
        const request = (requestId: string, version: string): void => {
            if (current?.readyState !== WebSocket.OPEN) {
                throw new Error("No working daemon");
            }
            current.send(JSON.stringify({ kind: "runtime.upgrade.request", requestId, version }));
        };
        try {
            packages.set(good, await packedRelease(directory, good, false, signal));
            packages.set(bad, await packedRelease(directory, bad, true, signal));
            await listen(server);
            registryUrl = `http://127.0.0.1:${port(server)}`;
            Object.assign(environment, { NPM_CONFIG_REGISTRY: registryUrl });
            const installation = await openMobiusCliInstallation(signal, environment);
            await installation.saveConnection(
                {
                    appId: "app_upgrade",
                    channelId: "upgrade-channel",
                    runtimeId: "runtime_upgrade",
                    pairingId: "",
                    defaultWorkspace: directory,
                    relayOrigin: new URL(registryUrl),
                    runtimeCredential: "r".repeat(43),
                },
                signal,
            );
            await writeFile(join(stateRoot, "versions", cliPackage.version, "retained-data"), "original-data");
            await cli(["start"]);
            await connected.promise;
            const control = await openMobiusControlInstallation(signal, environment);
            const manager = await readFile(join(control.stateDirectory, "manager.lock"), "utf8");
            const originalWorker = await readFile(join(control.stateDirectory, "worker.lock"), "utf8");
            // A leftover file, even with a live PID, must not block this process.
            await writeFile(join(control.stateDirectory, "upgrade.lock"), String(process.pid));
            request("upgrade_missing", "99.99.99");
            expect((await next()).outcome.status).toBe("accepted");
            request("upgrade_concurrent", good);
            expect(await next()).toMatchObject({
                requestId: "upgrade_concurrent",
                outcome: { status: "rejected", code: "upgrade_busy" },
            });
            expect(await next()).toMatchObject({
                requestId: "upgrade_missing",
                outcome: { status: "failed", code: "npm_install_failed" },
            });
            expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(originalWorker);
            request("upgrade_good", good);
            expect((await next()).outcome.status).toBe("accepted");
            expect(await next()).toMatchObject({
                requestId: "upgrade_good",
                version: good,
                outcome: { status: "succeeded" },
            });
            expect(await readFile(join(control.stateDirectory, "manager.lock"), "utf8")).toBe(manager);
            expect(await readFile(join(stateRoot, "versions", good, "retained-data"), "utf8")).toBe("original-data");
            await writeFile(join(stateRoot, "versions", good, "retained-data"), "upgraded-data");
            const reuse = `${cliPackage.version}-reuse`;
            packages.set(reuse, await packedRelease(directory, reuse, false, signal));
            await cp(join(stateRoot, "versions", good), join(stateRoot, "versions", reuse), { recursive: true });
            await writeFile(join(stateRoot, "versions", reuse, "retained-data"), "existing-target-data");
            request("upgrade_reuse", reuse);
            expect((await next()).outcome.status).toBe("accepted");
            expect(await next()).toMatchObject({
                requestId: "upgrade_reuse",
                version: reuse,
                outcome: { status: "succeeded" },
            });
            expect(await readFile(join(stateRoot, "versions", reuse, "retained-data"), "utf8")).toBe(
                "existing-target-data",
            );
            request("upgrade_broken", bad);
            expect((await next()).outcome.status).toBe("accepted");
            const failed = await next();
            expect(failed).toMatchObject({
                requestId: "upgrade_broken",
                version: reuse,
                targetVersion: bad,
                outcome: { status: "failed", code: "worker_exited" },
            });
            if (failed.outcome.status !== "failed") {
                throw new Error("Expected rollback feedback");
            }
            expect(failed.outcome.retryAfter).toBeGreaterThan(0);
            expect(await sendLocalRequest(control.stateDirectory, "manager", { kind: "status" }, signal)).toMatchObject(
                { worker: { version: reuse } },
            );
            const worker = await readFile(join(control.stateDirectory, "worker.lock"), "utf8");
            request("upgrade_retry", cliPackage.version);
            expect(await next()).toMatchObject({
                requestId: "upgrade_retry",
                outcome: { status: "rejected", code: "upgrade_cooldown", retryAfter: failed.outcome.retryAfter },
            });
            expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(worker);
            expect(await readFile(join(control.stateDirectory, "manager.lock"), "utf8")).toBe(manager);
            expect(await readFile(join(stateRoot, "versions", good, "retained-data"), "utf8")).toBe("upgraded-data");
            expect(await readFile(join(stateRoot, "versions", cliPackage.version, "retained-data"), "utf8")).toBe(
                "original-data",
            );
            if (failed.outcome.status === "failed") {
                expect(failed.outcome.stderr).toContain("Controlled startup failure");
                expect(failed.outcome.stdout).toContain("Starting controlled release");
            }
            await expect(readFile(join(control.stateDirectory, "worker-switch.json"))).rejects.toMatchObject({
                code: "ENOENT",
            });
            await expect(readFile(join(control.stateDirectory, "upgrade-request.json"))).rejects.toMatchObject({
                code: "ENOENT",
            });
            await cli(["quit"]);
            await cli(["start"], signal, join(directory, `source-${reuse}`, "src/cli.ts"));
            expect(
                await sendLocalRequest(
                    control.stateDirectory,
                    "manager",
                    { kind: "switch-status", wait: false },
                    signal,
                ),
            ).toEqual({ kind: "switch-status", state: null });
        } finally {
            await cli(["quit"], AbortSignal.timeout(20_000)).catch(() => undefined);
            signal.removeEventListener("abort", aborted);
            for (const socket of sockets.clients) {
                socket.terminate();
            }
            await new Promise<void>((done) => sockets.close(() => done()));
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
            await rm(directory, { recursive: true, force: true });
        }
    }, 270_000);
});
