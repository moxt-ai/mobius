import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMobiusRuntimeEngine } from "../../../packages/cli/src/runtime.ts";

it("Given an opaque relay-issued credential, When an embedding host creates a Runtime, Then startup proceeds without interpreting the credential format", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-runtime-credential-"));
    try {
        await expect(
            createMobiusRuntimeEngine(
                {
                    auditDatabasePath: join(directory, "audit.sqlite"),
                    channelId: "channel-1",
                    defaultWorkspace: join(directory, "workspace"),
                    relayUrl: "wss://relay.example.com/mobius/api/v1/runtimes/connect",
                    runtimeCredential: "a".repeat(73),
                },
                new AbortController().signal,
                { PATH: "" },
            ),
        ).resolves.toMatchObject({ run: expect.any(Function) });
        expect(await readdir(directory)).toEqual(["workspace"]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it("Given a credential outside the Runtime token format, When an embedding host creates a Runtime, Then configuration is rejected before workspace creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-runtime-credential-"));
    try {
        await expect(
            createMobiusRuntimeEngine(
                {
                    auditDatabasePath: join(directory, "audit.sqlite"),
                    channelId: "channel-1",
                    defaultWorkspace: join(directory, "workspace"),
                    relayUrl: "wss://relay.example.com/mobius/api/v1/runtimes/connect",
                    runtimeCredential: "a".repeat(31),
                },
                new AbortController().signal,
                { PATH: "" },
            ),
        ).rejects.toMatchObject({
            code: "runtime_configuration_invalid",
            message: "The Runtime relay credential is invalid",
        });
        expect(await readdir(directory)).toEqual([]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
