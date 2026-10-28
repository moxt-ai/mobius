import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const installation = process.env.MOBIUS_INSTALL_DIRECTORY;
assert.ok(installation, "MOBIUS_INSTALL_DIRECTORY must identify an installed release");
const root = resolve(installation);
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
    assert.deepEqual(
        Object.keys(engine).sort(),
        [
            "MobiusRuntimeEngine",
            "RuntimeRelayRevokedError",
            "openRuntimeInstallationStore",
            "pairMobiusRuntime",
            "resumeMobiusRuntime",
        ].sort(),
    );
    for (const name of [
        "openRuntimeInstallationStore",
        "pairMobiusRuntime",
        "resumeMobiusRuntime",
        "MobiusRuntimeEngine",
        "RuntimeRelayRevokedError",
    ]) {
        assert.equal(typeof engine[name], "function", name);
    }
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
            const store = await engine.openRuntimeInstallationStore(dataDirectory, stage.signal);
            const connection = await store.saveConnection(input, stage.signal);
            assert.equal(connection.appId, input.appId);
            assert.equal(Object.hasOwn(connection, "applicationId"), false);
            assert.deepEqual(await store.readConnection(connection.connectionId, stage.signal), connection);
            const record = JSON.parse(await readFile(store.connectionPath(connection.connectionId), "utf8"));
            assert.equal(record.version, 6);
            assert.equal(Object.hasOwn(record, "applicationId"), false);
        },
    );
    await context.test(
        "warm reopen and persisted connection read",
        { timeout: installationStageTimeout },
        async (stage) => {
            const store = await engine.openRuntimeInstallationStore(dataDirectory, stage.signal);
            const connections = await store.listConnections(stage.signal);
            assert.equal(connections.length, 1);
            const [connection] = connections;
            for (const [key, value] of Object.entries(input)) {
                assert.deepEqual(connection[key], value, key);
            }
            assert.equal(connection.installationId, store.installationId);
            assert.deepEqual(await store.readConnectionForPairing(input.pairingId, stage.signal), connection);
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
                engine.openRuntimeInstallationStore(cancelledDirectory, AbortSignal.abort(reason)),
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
            await assert.rejects(engine.openRuntimeInstallationStore(redirected, stage.signal), {
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
        NPM_CONFIG_OFFLINE: "true",
        NPM_CONFIG_CACHE: join(directory, "npm-cache"),
    };
    const run = (args, timeout = 45_000, signal = context.signal) =>
        execute(process.execPath, args, {
            cwd: root,
            env: environment,
            timeout,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            signal,
        });
    // Hooks report cleanup failures separately, without hiding a failed CLI command.
    context.after(async () => {
        // Cleanup has an independent deadline even when the scenario was cancelled.
        await run([entry, "quit"], 45_000, AbortSignal.timeout(45_000));
        await rm(directory, { recursive: true, force: true });
    });
    // Exercise this exact, potentially unpublished archive, not a registry release
    // with the same version. Missing-release downloads have their own registry journey.
    await cp(
        join(root, "node_modules"),
        join(environment.MOBIUS_STATE_DIRECTORY, "npm", metadata.version, "node_modules"),
        { recursive: true },
    );
    await context.test("installed ESM export", async (stage) => {
        await run(
            [
                "--input-type=module",
                "--eval",
                "import assert from 'node:assert/strict'; const engine = await import('@moxt-ai/mobius/engine'); assert.equal(typeof engine.openRuntimeInstallationStore, 'function');",
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
    // Release preflight and manager/worker startup have their own bounded deadlines.
    await context.test("daemon startup", async (stage) => {
        assert.match((await run([entry, "start"], 180_000, stage.signal)).stdout, /Mobius daemon is running/);
    });
    await context.test("running daemon version", async (stage) => {
        assert.equal(
            (await run([entry, "--version"], 45_000, stage.signal)).stdout,
            `CLI: ${metadata.version}\nDaemon: ${metadata.version}\n`,
        );
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
