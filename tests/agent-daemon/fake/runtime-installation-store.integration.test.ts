import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
    ImportedLegacyRuntimeConnection,
    openRuntimeInstallationStore,
    type RuntimeInstallationStoreError,
    VerifiedRuntimeConnection,
} from "../../../packages/cli/src/storage/runtime-installation-store.ts";

describe("Runtime installation storage", () => {
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
                    channelId,
                    defaultWorkspace: "/workspace/mobius",
                    relayOrigin: new URL("https://relay.example.com/"),
                    runtimeCredential: "a".repeat(43),
                    runtimeId: "runtime_mobius",
                },
                signal,
            );
            const moxtConnection = await moxt.saveConnection(
                {
                    channelId,
                    defaultWorkspace: "/workspace/moxt",
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
            expect(mobius.connectionPath(mobiusConnection.connectionId)).not.toContain("com.moxt.cli");
            expect(moxt.connectionPath(moxtConnection.connectionId)).toContain("com.moxt.cli");
            expect(mobius.connectionPath(mobiusConnection.connectionId)).not.toContain(channelId);
            expect(moxt.connectionPath(moxtConnection.connectionId)).not.toContain(channelId);
            expect(await readdir(join(moxt.stateDirectory, "channels"))).toEqual([
                expect.stringMatching(/^mci_[a-f0-9]{64}\.json$/),
            ]);
            expect(mobius.auditDatabasePath(mobiusConnection.connectionId)).not.toBe(
                moxt.auditDatabasePath(moxtConnection.connectionId),
            );
            await expect(mobius.readConnection(moxtConnection.connectionId, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            } satisfies Pick<RuntimeInstallationStoreError, "code">);
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });

    it("Given an explicitly selected legacy channel, When it is imported into one installation, Then the original file remains and no other installation gains the connection", async () => {
        const stateRoot = await mkdtemp(join(tmpdir(), "mobius-runtime-legacy-import-"));
        const signal = new AbortController().signal;
        const legacyChannelId = "legacy-channel";
        const legacyPath = join(stateRoot, "connections", `${legacyChannelId}.json`);
        try {
            await mkdir(join(stateRoot, "connections"), { mode: 0o700, recursive: true });
            await writeFile(
                legacyPath,
                `${JSON.stringify({
                    channelId: legacyChannelId,
                    defaultWorkspace: "/workspace/legacy",
                    relayOrigin: "https://relay.example.com/",
                    runtimeCredential: "c".repeat(43),
                })}\n`,
                { mode: 0o600 },
            );
            const mobius = await openRuntimeInstallationStore(
                { applicationId: "dev.mobius.cli", stateDirectory: stateRoot },
                signal,
            );
            const moxt = await openRuntimeInstallationStore(
                { applicationId: "com.moxt.cli", stateDirectory: stateRoot },
                signal,
            );

            const imported = await mobius.migrateLegacyConnection(stateRoot, legacyChannelId, signal);
            const resumed = await mobius.readConnection(imported.connectionId, signal);

            expect(imported).toBeInstanceOf(ImportedLegacyRuntimeConnection);
            expect(resumed.connectionId).toBe(imported.connectionId);
            expect(resumed.defaultWorkspace).toBe("/workspace/legacy");
            expect((await stat(legacyPath)).isFile()).toBe(true);
            await expect(moxt.readConnection(imported.connectionId, signal)).rejects.toMatchObject({
                code: "connection_not_found",
            } satisfies Pick<RuntimeInstallationStoreError, "code">);
        } finally {
            await rm(stateRoot, { force: true, recursive: true });
        }
    });
});
