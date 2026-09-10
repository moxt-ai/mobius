import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { MOBIUS_API_PREFIX, SESSION_PROMPT_KIND, type SessionPromptCommand } from "../../protocol/src/index.ts";
import { createDaemonConfig } from "../src/config.ts";
import { resolvePromptArtifacts } from "../src/prompt-artifact-resolver.ts";

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        const fail = (error: Error): void => reject(error);
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", fail);
            resolve();
        });
    });
}

function port(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("The artifact test server did not bind to a port");
    }
    return address.port;
}

function digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

describe("daemon prompt artifact resolution", () => {
    const servers: Server[] = [];

    afterEach(async () => {
        await Promise.all(
            servers.splice(0).map(
                (server) =>
                    new Promise<void>((resolve, reject) => {
                        server.close((error) => {
                            if (error === undefined) {
                                resolve();
                                return;
                            }
                            reject(error);
                        });
                    }),
            ),
        );
    });

    it("Given a Turn with server-owned artifact references, When the daemon resolves the prompt, Then it downloads with Runtime authority, verifies integrity, and exposes only Agent prompt content", async () => {
        const image = Uint8Array.from([137, 80, 78, 71]);
        const text = new TextEncoder().encode("resolved artifact context");
        const content = new Map([
            ["art_image", { bytes: image, mediaType: "image/png" }],
            ["art_text", { bytes: text, mediaType: "text/plain" }],
        ]);
        const requestedUrls: string[] = [];
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            requestedUrls.push(url.toString());
            const segments = url.pathname.split("/");
            const artifactId = segments.at(-2) ?? "";
            const found = content.get(artifactId);
            if (url.searchParams.get("token") !== "daemon-secret" || found === undefined) {
                response.writeHead(403);
                response.end();
                return;
            }
            response.writeHead(200, {
                "content-length": found.bytes.byteLength,
                "content-type": found.mediaType,
                "x-mobius-artifact-id": artifactId,
                "x-mobius-sha256": digest(found.bytes),
            });
            response.end(found.bytes);
        });
        servers.push(server);
        await listen(server);
        const relayUrl = new URL(
            `ws://127.0.0.1:${port(server).toString()}${MOBIUS_API_PREFIX}/channels/channel-artifact/daemon`,
        );
        relayUrl.searchParams.set("token", "daemon-secret");
        const config = createDaemonConfig({
            auditDatabasePath: "/tmp/mobius-artifact-test.sqlite",
            channelId: "channel-artifact",
            defaultWorkspace: "/tmp",
            relayUrl,
        });
        const command: SessionPromptCommand = {
            additionalDirectoryIds: [],
            agentId: "codex",
            bindingId: "workspace",
            commandId: "command-artifact",
            directoryId: "root",
            disposition: "reject",
            images: [],
            kind: SESSION_PROMPT_KIND,
            prompt: "Use the attachments",
            resources: [
                {
                    mimeType: "text/plain",
                    name: "inline.txt",
                    text: "inline context",
                    type: "embedded",
                    uri: "file:///inline.txt",
                },
                {
                    mimeType: "image/png",
                    name: "image.png",
                    text: "",
                    type: "link",
                    uri: `mobius-artifact:art_image?byteLength=${image.byteLength.toString()}&sha256=${digest(image)}`,
                },
                {
                    mimeType: "text/plain",
                    name: "context.txt",
                    text: "",
                    type: "link",
                    uri: `mobius-artifact:art_text?byteLength=${text.byteLength.toString()}&sha256=${digest(text)}`,
                },
            ],
            sessionId: "session-artifact",
            targetCommandId: "",
        };

        const resolved = await resolvePromptArtifacts(config, command, new AbortController().signal);

        expect(resolved.images).toEqual([
            {
                data: Buffer.from(image).toString("base64"),
                mimeType: "image/png",
                name: "image.png",
            },
        ]);
        expect(resolved.resources).toEqual([
            command.resources[0],
            {
                mimeType: "text/plain",
                name: "context.txt",
                text: "resolved artifact context",
                type: "embedded",
                uri: command.resources[2]?.uri,
            },
        ]);
        expect(requestedUrls).toHaveLength(2);
        expect(requestedUrls.every((url) => url.includes("token=daemon-secret"))).toBe(true);
    });

    it("Given a tampered artifact response, When integrity validation fails, Then the daemon rejects it with a stable sanitized error", async () => {
        const bytes = new TextEncoder().encode("tampered");
        const server = createServer((_request, response) => {
            response.writeHead(200, {
                "content-length": bytes.byteLength,
                "content-type": "text/plain",
                "x-mobius-artifact-id": "art_tampered",
                "x-mobius-sha256": digest(bytes),
            });
            response.end(bytes);
        });
        servers.push(server);
        await listen(server);
        const relayUrl = new URL(
            `ws://127.0.0.1:${port(server).toString()}${MOBIUS_API_PREFIX}/channels/channel-artifact/daemon?token=daemon-secret`,
        );
        const config = createDaemonConfig({
            auditDatabasePath: "/tmp/mobius-artifact-test.sqlite",
            channelId: "channel-artifact",
            defaultWorkspace: "/tmp",
            relayUrl,
        });
        const command: SessionPromptCommand = {
            additionalDirectoryIds: [],
            agentId: "codex",
            bindingId: "workspace",
            commandId: "command-artifact",
            directoryId: "root",
            disposition: "reject",
            images: [],
            kind: SESSION_PROMPT_KIND,
            prompt: "Use the attachment",
            resources: [
                {
                    mimeType: "text/plain",
                    name: "context.txt",
                    text: "",
                    type: "link",
                    uri: `mobius-artifact:art_tampered?byteLength=${bytes.byteLength.toString()}&sha256=${"0".repeat(64)}`,
                },
            ],
            sessionId: "session-artifact",
            targetCommandId: "",
        };

        await expect(resolvePromptArtifacts(config, command, new AbortController().signal)).rejects.toMatchObject({
            code: "artifact_integrity_failed",
            message: "The prompt artifact failed integrity validation",
        });
    });
});
