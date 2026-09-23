import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
    openRuntimeInstallationStore,
    type RuntimeInstallationStoreError,
    VerifiedRuntimeConnection,
} from "../../../packages/cli/src/storage/runtime-installation-store.ts";

describe("Runtime installation storage", () => {
    it("Given a saved connection whose App ID predates relay authority, When it is read, Then its caller-supplied App ID is not trusted", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-runtime-legacy-app-id-"));
        const signal = new AbortController().signal;
        try {
            const installation = await openRuntimeInstallationStore(
                { applicationId: "dev.mobius.cli", stateDirectory: stateRoot },
                signal,
            );
            const connectionId = `mcn_${"0".repeat(32)}`;
            const path = installation.connectionPath(connectionId);
            await mkdir(join(installation.stateDirectory, "connections"), { recursive: true });
            await writeFile(
                path,
                JSON.stringify({
                    activation: "stopped",
                    appId: "app_client_spoofed",
                    applicationId: installation.applicationId,
                    channelId: "legacy_channel",
                    connectionId,
                    defaultWorkspace: "/workspace/legacy",
                    installationId: installation.installationId,
                    kind: "verified",
                    pairingId: "legacy_pairing",
                    relayOrigin: "https://relay.example.com/",
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "legacy_runtime",
                    version: 4,
                }),
                { mode: 0o600 },
            );

            expect((await installation.readConnection(connectionId, signal)).appId).toBe("unknown");
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
