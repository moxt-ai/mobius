import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const installation = process.env.MOBIUS_INSTALL_DIRECTORY;
assert.ok(installation, "MOBIUS_INSTALL_DIRECTORY must identify an installed release");
const root = resolve(installation);
const unsupported = process.env.MOBIUS_EXPECT_UNSUPPORTED === "true";
const entry = join(root, "node_modules/@moxt-ai/mobius/dist/cli.js");
const metadata = JSON.parse(await readFile(join(root, "node_modules/@moxt-ai/mobius/package.json"), "utf8"));

test("Given an installed release, When a user imports its APIs and starts the CLI, Then help, version and daemon lifecycle work", {
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
    const run = (args, timeout = 45_000) =>
        execute(process.execPath, args, {
            cwd: root,
            env: environment,
            timeout,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
        });
    // Hooks report cleanup failures separately, without hiding a failed CLI command.
    context.after(async () => {
        await run([entry, "quit"]);
        await rm(directory, { recursive: true, force: true });
    });
    // Exercise this exact, potentially unpublished archive, not a registry release
    // with the same version. Missing-release downloads have their own registry journey.
    await cp(
        join(root, "node_modules"),
        join(environment.MOBIUS_STATE_DIRECTORY, "npm", metadata.version, "node_modules"),
        { recursive: true },
    );
    await run([
        "--input-type=module",
        "--eval",
        `import assert from 'node:assert/strict';
        import { readFile } from 'node:fs/promises';
        import { join } from 'node:path';
        const engine = await import('@moxt-ai/mobius/engine');
        assert.deepEqual(Object.keys(engine).sort(), ['MobiusRuntimeEngine', 'RuntimeRelayRevokedError', 'openRuntimeInstallationStore', 'pairMobiusRuntime', 'resumeMobiusRuntime'].sort());
        for (const name of ['openRuntimeInstallationStore', 'pairMobiusRuntime', 'resumeMobiusRuntime', 'MobiusRuntimeEngine', 'RuntimeRelayRevokedError']) {
            assert.equal(typeof engine[name], 'function', name);
        }
        const signal = AbortSignal.timeout(5000);
        const store = await engine.openRuntimeInstallationStore(join(process.env.MOBIUS_STATE_DIRECTORY, 'embedded-data'), signal);
        const connection = await store.saveConnection({
            appId: 'platform_installed',
            channelId: 'installed_channel',
            defaultWorkspace: join(process.env.MOBIUS_STATE_DIRECTORY, 'workspace'),
            pairingId: 'installed_pairing',
            relayOrigin: new URL('https://relay.example.com/'),
            runtimeCredential: 'a'.repeat(43),
            runtimeId: 'installed_runtime',
        }, signal);
        assert.equal(connection.appId, 'platform_installed');
        assert.equal(Object.hasOwn(connection, 'applicationId'), false);
        assert.deepEqual(await store.readConnection(connection.connectionId, signal), connection);
        const record = JSON.parse(await readFile(store.connectionPath(connection.connectionId), 'utf8'));
        assert.equal(record.version, 6);
        assert.equal(Object.hasOwn(record, 'applicationId'), false);`,
    ]);
    assert.match((await run([entry, "--help"])).stdout, /Usage: mobius/);
    assert.equal((await run([entry, "--version"])).stdout, `CLI: ${metadata.version}\nDaemon: not running\n`);
    // Release preflight and manager/worker startup have their own bounded deadlines.
    assert.match((await run([entry, "start"], 180_000)).stdout, /Mobius daemon is running/);
    assert.equal((await run([entry, "--version"])).stdout, `CLI: ${metadata.version}\nDaemon: ${metadata.version}\n`);
    await run([entry, "quit"]);
    assert.equal((await run([entry, "--version"])).stdout, `CLI: ${metadata.version}\nDaemon: not running\n`);
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
