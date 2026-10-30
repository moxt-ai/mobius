import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
// npm adds the selected package's bin directory to PATH for the test host.
// Resolve that actual cache entry, without installing or copying the release ourselves.
const root = (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .map((directory) => resolve(directory, "../.."))
    .find((directory) => existsSync(join(directory, "node_modules/@moxt-ai/mobius/package.json")));
assert.ok(root, "Run this suite through npx --package=<release archive>");
const archive = process.env.MOBIUS_RELEASE_ARCHIVE;
assert.ok(archive, "MOBIUS_RELEASE_ARCHIVE must identify the exact PR archive");
assert.ok(process.env.npm_execpath, "npx must supply its npm entrypoint");
const npxEntry = join(dirname(process.env.npm_execpath), "npx-cli.js");
const unsupported = process.env.MOBIUS_EXPECT_UNSUPPORTED === "true";
const entry = join(root, "node_modules/@moxt-ai/mobius/dist/cli.js");
const metadata = JSON.parse(await readFile(join(root, "node_modules/@moxt-ai/mobius/package.json"), "utf8"));

// A native Windows ACL check can use 30 seconds. Each public operation gets
// its own 45-second stage; cold initialization must not share a 5-second budget
// with subsequent writes. node:test reports each stage's duration and cancels
// the production operation through that stage's signal.
const installationStageTimeout = 45_000;

test("Given an installed release, When an embedding host opens its storage, Then native permissions and persisted connections survive reopening", {
    timeout: installationStageTimeout * 6,
    skip: unsupported,
}, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-installed-engine-"));
    context.after(async () => {
        await rm(directory, { recursive: true, force: true });
    });
    const dataDirectory = join(directory, "embedded-data");
    const requireInstalled = createRequire(join(root, "package.json"));
    const engine = await import(pathToFileURL(requireInstalled.resolve("@moxt-ai/mobius/engine")).href);
    assert.deepEqual(Object.keys(engine).sort(), ["MobiusRuntimeEngine", "RuntimeRelayRevokedError"].sort());
    for (const name of ["MobiusRuntimeEngine", "RuntimeRelayRevokedError"]) {
        assert.equal(typeof engine[name], "function", name);
    }
    const connectionsFor = (engineDataDir) =>
        new engine.MobiusRuntimeEngine({
            engineDataDir,
            agentLaunchEnvironment: { PATH: "" },
        }).getConnectionManager();
    const input = {
        appId: "platform_installed",
        channelId: "installed_channel",
        defaultWorkspace: join(directory, "workspace"),
        pairingId: "installed_pairing",
        relayOrigin: new URL("https://relay.example.com/"),
        runtimeCredential: "a".repeat(43),
        runtimeId: "installed_runtime",
    };
    await context.test(
        "cold initialization and connection write/read",
        { timeout: installationStageTimeout },
        async (stage) => {
            const connections = connectionsFor(dataDirectory);
            const connection = await connections.save(input, stage.signal);
            assert.equal(connection.appId, input.appId);
            assert.equal(Object.hasOwn(connection, "applicationId"), false);
            assert.deepEqual(await connections.read(connection.connectionId, stage.signal), connection);
            const record = JSON.parse(
                await readFile(
                    join(dataDirectory, connection.installationId, "connections", `${connection.connectionId}.json`),
                    "utf8",
                ),
            );
            assert.equal(record.version, 6);
            assert.equal(Object.hasOwn(record, "applicationId"), false);
        },
    );
    await context.test(
        "warm reopen and persisted connection read",
        { timeout: installationStageTimeout },
        async (stage) => {
            const manager = connectionsFor(dataDirectory);
            const connections = await manager.list(stage.signal);
            assert.equal(connections.length, 1);
            const [connection] = connections;
            for (const [key, value] of Object.entries(input)) {
                assert.deepEqual(connection[key], value, key);
            }
            const pointer = JSON.parse(await readFile(join(dataDirectory, "current.json"), "utf8"));
            assert.equal(connection.installationId, pointer.installationId);
            assert.deepEqual(await manager.read(connection.connectionId, stage.signal), connection);
        },
    );
    await context.test(
        "native owner-only storage permissions",
        { timeout: installationStageTimeout },
        async (stage) => {
            if (process.platform !== "win32") {
                assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
                return;
            }
            // Observe the resulting ACL independently through Windows, without
            // replacing the production permission implementation or trusting chmod.
            // Read .NET ACLs directly: a PowerShell 7 parent can expose modules
            // that Windows PowerShell 5.1 cannot load through Get-Acl.
            const systemRoot = Object.entries(process.env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
            assert.ok(systemRoot);
            const script = `
$ErrorActionPreference = 'Stop'
$acl = [IO.Directory]::GetAccessControl($env:MOBIUS_TEST_PERMISSION_PATH)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Unexpected owner' }
if (-not $acl.AreAccessRulesProtected) { throw 'Inherited permissions remain enabled' }
$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
if ($rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'Storage is not owner-only' }
`;
            await execute(
                join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
                [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-EncodedCommand",
                    Buffer.from(script, "utf16le").toString("base64"),
                ],
                {
                    env: { ...process.env, MOBIUS_TEST_PERMISSION_PATH: dataDirectory },
                    signal: stage.signal,
                    timeout: 30_000,
                    windowsHide: true,
                },
            );
        },
    );
    await context.test(
        "cancelled initialization leaves no installation",
        { timeout: installationStageTimeout },
        async () => {
            const cancelledDirectory = join(directory, "cancelled");
            const reason = new Error("Host cancelled initialization");
            await assert.rejects(
                connectionsFor(cancelledDirectory).list(AbortSignal.abort(reason)),
                (error) => error === reason,
            );
            await assert.rejects(stat(cancelledDirectory), { code: "ENOENT" });
        },
    );
    await context.test(
        "redirected storage is rejected without writing through the link",
        { timeout: installationStageTimeout },
        async (stage) => {
            const target = await mkdtemp(join(directory, "target-"));
            const redirected = join(directory, "redirected");
            await symlink(target, redirected, process.platform === "win32" ? "junction" : "dir");
            await assert.rejects(connectionsFor(redirected).list(stage.signal), {
                code: "installation_unavailable",
            });
            assert.deepEqual(await readdir(target), []);
        },
    );
});

test("Given an installed release, When a user starts the CLI, Then help, version and daemon lifecycle work", {
    timeout: 300_000,
    skip: unsupported,
}, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-installed-release-"));
    const environment = {
        ...process.env,
        MOBIUS_STATE_DIRECTORY: join(directory, "state"),
    };
    const run = (args, timeout = 45_000, signal = context.signal) =>
        execute(
            process.execPath,
            args[0] === entry
                ? [npxEntry, "--yes", "--prefer-online", "--package", archive, "--", "mobius", ...args.slice(1)]
                : args,
            {
                cwd: root,
                env: environment,
                timeout,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
                signal,
            },
        );
    // Hooks report cleanup failures separately, without hiding a failed CLI command.
    context.after(async () => {
        // Cleanup has an independent deadline even when the scenario was cancelled.
        await run([entry, "quit"], 45_000, AbortSignal.timeout(45_000));
        await rm(directory, { recursive: true, force: true });
    });
    await context.test("installed ESM export", async (stage) => {
        await run(
            [
                "--input-type=module",
                "--eval",
                "import assert from 'node:assert/strict'; const engine = await import('@moxt-ai/mobius/engine'); assert.equal(typeof engine.MobiusRuntimeEngine, 'function');",
            ],
            45_000,
            stage.signal,
        );
    });
    await context.test("CLI help and stopped version", async (stage) => {
        assert.match((await run([entry, "--help"], 45_000, stage.signal)).stdout, /Usage: mobius/);
        assert.equal(
            (await run([entry, "--version"], 45_000, stage.signal)).stdout,
            `CLI: ${metadata.version}\nDaemon: not running\n`,
        );
    });
    // Each public lifecycle command goes through the real npx package runner.
    await context.test("daemon startup", async (stage) => {
        assert.match((await run([entry, "start"], 180_000, stage.signal)).stdout, /Mobius daemon is running/);
    });
    await context.test("running daemon version", async (stage) => {
        assert.equal(
            (await run([entry, "--version"], 45_000, stage.signal)).stdout,
            `CLI: ${metadata.version}\nDaemon: ${metadata.version}\n`,
        );
    });
    await context.test("repeated start reuses the daemon and restart replaces it", async (stage) => {
        const control = join(environment.MOBIUS_STATE_DIRECTORY, "installations", "dev.mobius.cli");
        const pointer = JSON.parse(await readFile(join(control, "current.json"), "utf8"));
        const lock = join(control, pointer.installationId, "manager.lock");
        const before = await readFile(lock, "utf8");
        await run([entry, "start"], 45_000, stage.signal);
        assert.equal(await readFile(lock, "utf8"), before);
        await run([entry, "restart"], 90_000, stage.signal);
        assert.notEqual(await readFile(lock, "utf8"), before);
        await assert.rejects(stat(join(environment.MOBIUS_STATE_DIRECTORY, "npm")), { code: "ENOENT" });
    });
    await context.test("daemon shutdown", async (stage) => {
        await run([entry, "quit"], 45_000, stage.signal);
        assert.equal(
            (await run([entry, "--version"], 45_000, stage.signal)).stdout,
            `CLI: ${metadata.version}\nDaemon: not running\n`,
        );
    });
});

test("Given an unsupported Node version, When a user launches the installed CLI, Then it reports the requirement without a syntax crash", {
    skip: !unsupported,
}, async () => {
    await assert.rejects(
        execute(process.execPath, [entry, "--help"], { cwd: root, timeout: 30_000, windowsHide: true }),
        (error) => {
            assert.equal(error.code, 1);
            assert.match(error.stderr, /Mobius requires Node.js/);
            assert.ok(error.stderr.includes(process.versions.node));
            assert.ok(error.stderr.includes(process.execPath));
            assert.doesNotMatch(error.stderr, /SyntaxError/);
            return true;
        },
    );
});
