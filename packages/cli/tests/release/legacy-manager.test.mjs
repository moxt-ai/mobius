import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, watch, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const oldVersion = "0.0.381";

test("Given a released manager, When it upgrades its worker, Then the new release stays usable until restart replaces the manager", {
    timeout: 300_000,
}, async (context) => {
    const archive = process.env.MOBIUS_RELEASE_ARCHIVE;
    assert.ok(archive);
    assert.ok(process.env.npm_execpath);
    const npx = join(dirname(process.env.npm_execpath), "npx-cli.js");
    const root = (process.env.PATH ?? process.env.Path ?? "")
        .split(delimiter)
        .map((directory) => resolve(directory, "../.."))
        .find((directory) => existsSync(join(directory, "node_modules/@moxt-ai/mobius/package.json")));
    assert.ok(root);
    const next = JSON.parse(await readFile(join(root, "node_modules/@moxt-ai/mobius/package.json"), "utf8"));
    const published = await execute(
        process.execPath,
        [
            process.env.npm_execpath,
            "view",
            `@moxt-ai/mobius@${oldVersion}`,
            "--json",
            "--registry=https://registry.npmjs.org",
        ],
        { signal: context.signal, timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const previous = JSON.parse(published.stdout);
    const tarball = await readFile(archive);
    const directory = await mkdtemp(join(tmpdir(), "mobius-legacy-journey-"));
    const clock = join(directory, "advance-clock");
    await writeFile(clock, "0");
    // A real npm registry boundary advertises the unpublished candidate. Both
    // versions still use real npm/npx and the old manager is an unmodified release.
    let origin;
    const registry = createServer((request, response) => {
        const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        if (path === "/candidate.tgz") {
            response.writeHead(200, { "content-type": "application/octet-stream" });
            response.end(tarball);
        } else if (path === "/@moxt-ai/mobius") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    name: next.name,
                    "dist-tags": { latest: next.version },
                    versions: {
                        [oldVersion]: previous,
                        [next.version]: {
                            ...next,
                            dist: {
                                tarball: `${origin}/candidate.tgz`,
                                integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
                            },
                        },
                    },
                }),
            );
        } else {
            response.writeHead(302, { location: `https://registry.npmjs.org${request.url}` });
            response.end();
        }
    });
    await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
    const address = registry.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    const environment = {
        ...process.env,
        MOBIUS_STATE_DIRECTORY: join(directory, "state"),
        npm_config_cache: join(directory, "npm-cache"),
        npm_config_registry: origin,
        // Dependencies keep their published HTTPS tarball URLs. Older npm versions
        // otherwise substitute the fixture host while retaining the HTTPS scheme.
        npm_config_replace_registry_host: "never",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        MOBIUS_TEST_LEGACY_CLOCK: clock,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(import.meta.dirname, "legacy-manager-clock.mjs")).href}`,
    };
    const run = async (version, args, signal = context.signal) => {
        try {
            return await execute(
                process.execPath,
                [npx, "--yes", "--prefer-online", "--package", `@moxt-ai/mobius@${version}`, "--", "mobius", ...args],
                {
                    env: environment,
                    cwd: directory,
                    signal,
                    timeout: 120_000,
                    windowsHide: true,
                    maxBuffer: 1024 * 1024,
                },
            );
        } catch (cause) {
            const logs = join(environment.npm_config_cache, "_logs");
            for (const file of (await readdir(logs).catch(() => [])).sort().slice(-3)) {
                context.diagnostic(`${file}\n${(await readFile(join(logs, file), "utf8")).slice(-6000)}`);
            }
            throw cause;
        }
    };
    context.after(async () => {
        try {
            await run(next.version, ["stop"], AbortSignal.timeout(60_000));
        } finally {
            await new Promise((resolve) => registry.close(resolve));
            await rm(directory, { recursive: true, force: true });
        }
    });
    await run(oldVersion, ["start"]);
    const control = join(environment.MOBIUS_STATE_DIRECTORY, "installations", "dev.mobius.cli");
    const pointer = JSON.parse(await readFile(join(control, "current.json"), "utf8"));
    const state = join(control, pointer.installationId);
    const manager = await readFile(join(state, "manager.lock"), "utf8");
    assert.match(
        (await run(oldVersion, ["--version"])).stdout,
        new RegExp(`Daemon: ${oldVersion.replaceAll(".", "\\.")}`),
    );
    // Advance only time; the released worker's own hourly loop downloads the
    // candidate and asks its real manager to switch it.
    const upgraded = (async () => {
        for await (const _event of watch(join(state, "logs"), { signal: context.signal })) {
            const log = await readFile(join(state, "logs", "worker-lifecycle.log"), "utf8");
            const entries = log
                .split("\n")
                .filter((line) => line.startsWith("Mobius worker lifecycle "))
                .map((line) => JSON.parse(line.slice("Mobius worker lifecycle ".length)));
            const candidate = entries.find(
                (entry) =>
                    entry.version === next.version &&
                    (entry.kind === "worker_ready" || entry.kind === "worker_start_failed"),
            );
            if (candidate) {
                assert.equal(candidate.kind, "worker_ready", JSON.stringify(candidate));
                return;
            }
        }
        throw new Error("The manager did not report an upgrade result");
    })();
    await writeFile(clock, "3600000");
    await upgraded;
    assert.equal(await readFile(join(state, "manager.lock"), "utf8"), manager);
    assert.match(
        (await run(next.version, ["--version"])).stdout,
        new RegExp(`Daemon: ${next.version.replaceAll(".", "\\.")}`),
    );
    await run(next.version, ["start"]);
    await run(next.version, ["release"]);
    assert.match((await run(oldVersion, ["upgrade"])).stdout, /already the newest release/);
    await run(next.version, ["restart"]);
    assert.notEqual(await readFile(join(state, "manager.lock"), "utf8"), manager);
    await assert.rejects(stat(join(state, "worker.lock")), { code: "ENOENT" });
    await run(next.version, ["start"]);
    await run(next.version, ["release"]);
    await run(next.version, ["stop"]);
    assert.match((await run(next.version, ["--version"])).stdout, /Daemon: not running/);
});
