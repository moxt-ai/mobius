import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMobiusRuntimeEngine } from "../../src/engine/runtime/engine.ts";

it("Given an opaque relay-issued credential, When an embedding host creates a Runtime, Then startup proceeds without interpreting the credential format", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-runtime-credential-"));
    try {
        await expect(
            createMobiusRuntimeEngine({
                engineDataDir: join(directory, "engine-data"),
                connection: {
                    channelId: "channel-1",
                    defaultWorkspace: join(directory, "workspace"),
                    relayUrl: "wss://relay.example.com/mobius/api/v1/runtimes/connect",
                    runtimeCredential: "a".repeat(73),
                },
                signal: new AbortController().signal,
                agentLaunchEnvironment: { PATH: "" },
            }),
        ).resolves.toMatchObject({ run: expect.any(Function) });
        expect((await readdir(directory)).sort()).toEqual(["engine-data", "workspace"]);
        const entries = (await readdir(join(directory, "engine-data"))).sort();
        expect(entries).toEqual(["current.json", expect.stringMatching(/^min_[a-f0-9]{32}$/)]);
        expect(JSON.parse(await readFile(join(directory, "engine-data", "current.json"), "utf8"))).toEqual({
            installationId: entries[1],
            version: 1,
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it("Given a credential outside the Runtime token format, When an embedding host creates a Runtime, Then configuration is rejected before workspace creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-runtime-credential-"));
    try {
        await expect(
            createMobiusRuntimeEngine({
                engineDataDir: join(directory, "engine-data"),
                connection: {
                    channelId: "channel-1",
                    defaultWorkspace: join(directory, "workspace"),
                    relayUrl: "wss://relay.example.com/mobius/api/v1/runtimes/connect",
                    runtimeCredential: "a".repeat(31),
                },
                signal: new AbortController().signal,
                agentLaunchEnvironment: { PATH: "" },
            }),
        ).rejects.toMatchObject({
            code: "runtime_configuration_invalid",
            message: "The Runtime relay credential is invalid",
        });
        expect(await readdir(directory)).toEqual([]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
