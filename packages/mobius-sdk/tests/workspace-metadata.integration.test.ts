import { createServer } from "node:http";
import { MobiusClient, StaticMobiusCredentialProvider } from "@moxt-ai/mobius-sdk";
import { expect, it } from "vitest";

// @no-uc: Compatibility; an older HTTP receiver can ignore the metadata hint and return a full listing.
it("reads directory metadata from an older receiver that returns the original workspace listing", async () => {
    const received = Promise.withResolvers<unknown>();
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        received.resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
            JSON.stringify({
                bindingId: "workspace",
                directoryId: "default",
                directoryLabel: "Workspace",
                entries: [{ directoryId: "child", name: "child" }],
                kind: "workspace.entries",
                parentDirectoryId: "home",
                requestId: "legacy-workspace",
            }),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Workspace compatibility server did not listen");
        }
        const client = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider("test-project-credential"),
            endpoint: `http://127.0.0.1:${address.port}`,
            projectId: "project-metadata",
        });
        const metadata = await client.runtimes.describeWorkspace(
            "runtime-metadata",
            "default",
            AbortSignal.timeout(5_000),
        );
        expect(metadata).toStrictEqual({ directoryId: "default", directoryLabel: "Workspace" });
        expect(await received.promise).toStrictEqual({ directoryId: "default", view: "metadata" });
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
});
