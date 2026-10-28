import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MobiusRuntimeEngine } from "../../src/exports/engine.ts";

it("Given a credential outside the Runtime token format, When an embedding host runs a provided connection, Then configuration is rejected before workspace creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-runtime-credential-"));
    try {
        const engine = new MobiusRuntimeEngine({
            engineDataDir: join(directory, "engine-data"),
            agentLaunchEnvironment: { PATH: "" },
        });
        await expect(
            engine.runLoop({
                connection: {
                    kind: "provided",
                    connection: {
                        channelId: "channel-1",
                        defaultWorkspace: join(directory, "workspace"),
                        relayUrl: "wss://relay.example.com/mobius/api/v1/runtimes/connect",
                        runtimeCredential: "a".repeat(31),
                    },
                },
                signal: AbortSignal.timeout(5_000),
            }),
        ).rejects.toMatchObject({
            code: "runtime_configuration_invalid",
            message: "The Runtime relay credential is invalid",
        });
        expect(await readdir(directory)).not.toContain("workspace");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
