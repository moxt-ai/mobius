import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { VerifiedRuntimeConnection } from "../../src/engine/runtime/connection/runtime-connection.ts";
import {
    RuntimeInstallationStore,
    type RuntimeInstallationStoreError,
} from "../../src/engine/runtime/connection/runtime-installation-store.ts";

describe("Runtime installation storage", () => {
    it("Given an ordinary data directory name, When a host saves a connection, Then local storage accepts the path without treating it as an application identity", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-engine-directory-"));
        const signal = new AbortController().signal;
        try {
            const installation = await RuntimeInstallationStore.open(join(directory, "data"), signal);
            const connection = await installation.saveConnection(
                {
                    appId: "platform_app",
                    channelId: "channel_directory",
                    defaultWorkspace: join(directory, "workspace"),
                    pairingId: "pairing_directory",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "runtime_directory",
                },
                signal,
            );
            expect(connection.appId).toBe("platform_app");
            expect(connection).not.toHaveProperty("applicationId");
            const record: unknown = JSON.parse(
                await readFile(installation.connectionPath(connection.connectionId), "utf8"),
            );
            expect(record).not.toHaveProperty("applicationId");
            expect(record).toMatchObject({ appId: "platform_app", version: 6 });
            const [indexFile] = await readdir(join(installation.stateDirectory, "channels"));
            if (indexFile === undefined) {
                throw new Error("The saved connection has no channel index");
            }
            const index: unknown = JSON.parse(
                await readFile(join(installation.stateDirectory, "channels", indexFile), "utf8"),
            );
            expect(index).not.toHaveProperty("applicationId");
            expect(index).toMatchObject({ version: 2 });
            await expect(installation.readConnection(connection.connectionId, signal)).resolves.toEqual(connection);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("Given retained version-5 connection and version-1 index records, When Engine updates activation, Then the original disk format and applicationId survive without becoming Engine identity", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mobius-retained-pairing-"));
        const signal = new AbortController().signal;
        try {
            const installation = await RuntimeInstallationStore.open(join(directory, "data"), signal);
            const connectionId = `mcn_${"a".repeat(32)}`;
            const channelId = "retained_channel";
            await mkdir(join(installation.stateDirectory, "connections"), { recursive: true });
            await mkdir(join(installation.stateDirectory, "channels"), { recursive: true });
            await writeFile(
                installation.connectionPath(connectionId),
                JSON.stringify({
                    activation: "active",
                    applicationId: "com.earlier.host",
                    appId: "platform_retained",
                    channelId,
                    connectionId,
                    defaultWorkspace: join(directory, "workspace"),
                    installationId: installation.installationId,
                    kind: "verified",
                    pairingId: "retained_pairing",
                    relayOrigin: "https://relay.example.com/",
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "retained_runtime",
                    version: 5,
                }),
                { mode: 0o600 },
            );
            const channelHash = createHash("sha256").update(channelId).digest("hex");
            await writeFile(
                join(installation.stateDirectory, "channels", `mci_${channelHash}.json`),
                JSON.stringify({
                    applicationId: "com.earlier.host",
                    channelId,
                    connectionId,
                    installationId: installation.installationId,
                    version: 1,
                }),
                { mode: 0o600 },
            );

            const connection = await installation.readConnection(connectionId, signal);
            expect(connection).toMatchObject({
                appId: "platform_retained",
                installationId: installation.installationId,
            });
            expect(connection).not.toHaveProperty("applicationId");
            await expect(
                installation.saveConnection(
                    {
                        appId: connection.appId,
                        channelId,
                        defaultWorkspace: connection.defaultWorkspace,
                        pairingId: "duplicate_pairing",
                        relayOrigin: connection.relayOrigin,
                        runtimeCredential: connection.runtimeCredential,
                        runtimeId: connection.runtimeId,
                    },
                    signal,
                ),
            ).rejects.toMatchObject({ code: "connection_conflict" });
            await installation.setConnectionActivation(connectionId, "stopped", signal);
            const rewritten: unknown = JSON.parse(await readFile(installation.connectionPath(connectionId), "utf8"));
            expect(rewritten).toMatchObject({
                activation: "stopped",
                appId: "platform_retained",
                applicationId: "com.earlier.host",
                version: 5,
            });
            await installation.setConnectionActivation(connectionId, "active", signal);
            expect(JSON.parse(await readFile(installation.connectionPath(connectionId), "utf8"))).toMatchObject({
                activation: "active",
                applicationId: "com.earlier.host",
                version: 5,
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("Given an existing installation moved to a differently named directory, When a host opens it explicitly, Then old and new entrypoints retain the same identity and connections", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-engine-context-"));
        const signal = new AbortController().signal;
        try {
            const original = await RuntimeInstallationStore.open(
                join(stateRoot, "installations", "dev.mobius.cli"),
                signal,
            );
            const connection = await original.saveConnection(
                {
                    appId: "app_context",
                    channelId: "channel_context",
                    defaultWorkspace: join(stateRoot, "workspace"),
                    pairingId: "pairing_context",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "runtime_context",
                },
                signal,
            );
            const relocated = join(stateRoot, "renamed-data");
            await rename(join(stateRoot, "installations", "dev.mobius.cli"), relocated);
            const engine = await RuntimeInstallationStore.open(relocated, signal);
            expect(engine.installationId).toBe(original.installationId);
            expect(engine.stateDirectory).toBe(join(relocated, original.installationId));
            await expect(engine.readConnection(connection.connectionId, signal)).resolves.toEqual(connection);
            const saved = await engine.saveConnection(
                {
                    appId: "app_new",
                    channelId: "channel_new",
                    defaultWorkspace: join(stateRoot, "workspace"),
                    pairingId: "pairing_new",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "b".repeat(43),
                    runtimeId: "runtime_new",
                },
                signal,
            );
            await rename(relocated, join(stateRoot, "installations", "dev.mobius.cli"));
            await expect(original.readConnection(saved.connectionId, signal)).resolves.toEqual(saved);
        } finally {
            await rm(stateRoot, { recursive: true, force: true });
        }
    });

    it("Given an obsolete pairing record, When the Runtime restores it, Then it rejects the record without a compatibility fallback", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-obsolete-pairing-"));
        const signal = new AbortController().signal;
        try {
            const installation = await RuntimeInstallationStore.open(
                join(stateRoot, "installations", "dev.mobius.cli"),
                signal,
            );
            const connectionId = `mcn_${"0".repeat(32)}`;
            await mkdir(join(installation.stateDirectory, "connections"), { recursive: true });
            await writeFile(
                installation.connectionPath(connectionId),
                JSON.stringify({
                    activation: "active",
                    appId: "app_old",
                    applicationId: "dev.mobius.cli",
                    channelId: "old_channel",
                    connectionId,
                    defaultWorkspace: "/workspace/old",
                    installationId: installation.installationId,
                    kind: "verified",
                    pairingId: "old_pairing",
                    relayOrigin: "https://relay.example.com/",
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "old_runtime",
                    version: 4,
                }),
                { mode: 0o600 },
            );
            await expect(installation.readConnection(connectionId, signal)).rejects.toMatchObject({
                code: "invalid_connection",
            });
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });

    it("Given two isolated Engine data directories, When each saves a Runtime connection, Then each resumes only its own opaque connection", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-runtime-installations-"));
        const signal = new AbortController().signal;
        const channelId = "shared:channel";
        try {
            const mobius = await RuntimeInstallationStore.open(join(stateRoot, "mobius-data"), signal);
            const moxt = await RuntimeInstallationStore.open(join(stateRoot, "moxt-data"), signal);
            const mobiusConnection = await mobius.saveConnection(
                {
                    appId: "app_mobius",
                    channelId,
                    defaultWorkspace: "/workspace/mobius",
                    pairingId: "pairing_mobius",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "runtime_mobius",
                },
                signal,
            );
            const moxtConnection = await moxt.saveConnection(
                {
                    appId: "app_moxt",
                    channelId,
                    defaultWorkspace: "/workspace/moxt",
                    pairingId: "pairing_moxt",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "b".repeat(43),
                    runtimeId: "runtime_moxt",
                },
                signal,
            );

            const resumed = await moxt.readConnection(moxtConnection.connectionId, signal);

            expect(resumed.channelId).toBe(channelId);
            expect(resumed).toBeInstanceOf(VerifiedRuntimeConnection);
            if (!(resumed instanceof VerifiedRuntimeConnection)) {
                throw new Error("Expected a verified Runtime connection");
            }
            expect(resumed.runtimeId).toBe("runtime_moxt");
            expect(resumed.appId).toBe("app_moxt");
            await expect(moxt.listConnections(signal)).resolves.toEqual([resumed]);
            await expect(moxt.readConnectionForPairing("pairing_moxt", signal)).resolves.toEqual(resumed);
            expect(mobius.connectionPath(mobiusConnection.connectionId)).not.toContain("moxt-data");
            expect(moxt.connectionPath(moxtConnection.connectionId)).toContain("moxt-data");
            expect(mobius.connectionPath(mobiusConnection.connectionId)).not.toContain(channelId);
            expect(moxt.connectionPath(moxtConnection.connectionId)).not.toContain(channelId);
            expect(await readdir(join(moxt.stateDirectory, "channels"))).toEqual([
                expect.stringMatching(/^mci_[a-f0-9]{64}\.json$/),
            ]);
            await expect(mobius.readConnection(moxtConnection.connectionId, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            } satisfies Pick<RuntimeInstallationStoreError, "code">);
            await writeFile(
                mobius.connectionPath(moxtConnection.connectionId),
                await readFile(moxt.connectionPath(moxtConnection.connectionId)),
                { mode: 0o600 },
            );
            await expect(mobius.readConnection(moxtConnection.connectionId, signal)).rejects.toMatchObject({
                code: "connection_owner_mismatch",
            });
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });
});
