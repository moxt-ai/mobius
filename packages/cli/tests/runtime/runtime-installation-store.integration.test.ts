import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
    openRuntimeInstallationStore,
    type RuntimeInstallationStoreError,
    VerifiedRuntimeConnection,
} from "../../src/storage/runtime-installation-store.ts";

describe("Runtime installation storage", () => {
    it("Given an obsolete pairing record, When the Runtime restores it, Then it rejects the record without a compatibility fallback", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-obsolete-pairing-"));
        const signal = new AbortController().signal;
        try {
            const installation = await openRuntimeInstallationStore(
                { applicationId: "dev.mobius.cli", stateDirectory: stateRoot },
                signal,
            );
            const connectionId = `mcn_${"0".repeat(32)}`;
            await mkdir(join(installation.stateDirectory, "connections"), { recursive: true });
            await writeFile(
                installation.connectionPath(connectionId),
                JSON.stringify({
                    activation: "active",
                    appId: "app_old",
                    applicationId: installation.applicationId,
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

    it("Given a saved connection without a proxy policy, When the Runtime restores it, Then it uses the direct route", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-connection-without-proxy-policy-"));
        const signal = new AbortController().signal;
        try {
            const installation = await openRuntimeInstallationStore(
                { applicationId: "dev.mobius.cli", stateDirectory: stateRoot },
                signal,
            );
            const connectionId = `mcn_${"0".repeat(32)}`;
            await mkdir(join(installation.stateDirectory, "connections"), { recursive: true });
            await writeFile(
                installation.connectionPath(connectionId),
                JSON.stringify({
                    activation: "active",
                    appId: "app_saved",
                    applicationId: installation.applicationId,
                    channelId: "saved_channel",
                    connectionId,
                    defaultWorkspace: "/workspace/saved",
                    installationId: installation.installationId,
                    kind: "verified",
                    pairingId: "saved_pairing",
                    relayOrigin: "https://relay.example.com/",
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "saved_runtime",
                    version: 5,
                }),
                { mode: 0o600 },
            );

            await expect(installation.readConnection(connectionId, signal)).resolves.toMatchObject({
                relayProxy: "direct",
            });
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });

    it("Given Mobius and Moxt installations on one user state root, When each saves a Runtime connection, Then each resumes only its own opaque connection from isolated state", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-runtime-installations-"));
        const signal = new AbortController().signal;
        const channelId = "shared:channel";
        try {
            const mobius = await openRuntimeInstallationStore(
                { applicationId: "dev.mobius.cli", stateDirectory: stateRoot },
                signal,
            );
            const moxt = await openRuntimeInstallationStore(
                { applicationId: "com.moxt.cli", stateDirectory: stateRoot },
                signal,
            );
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
            expect(mobius.connectionPath(mobiusConnection.connectionId)).not.toContain("com.moxt.cli");
            expect(moxt.connectionPath(moxtConnection.connectionId)).toContain("com.moxt.cli");
            expect(mobius.connectionPath(mobiusConnection.connectionId)).not.toContain(channelId);
            expect(moxt.connectionPath(moxtConnection.connectionId)).not.toContain(channelId);
            expect(await readdir(join(moxt.stateDirectory, "channels"))).toEqual([
                expect.stringMatching(/^mci_[a-f0-9]{64}\.json$/),
            ]);
            await expect(mobius.readConnection(moxtConnection.connectionId, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            } satisfies Pick<RuntimeInstallationStoreError, "code">);
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });
});
