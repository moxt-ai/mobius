import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ExternalImageContentBlock, SessionEvent } from "@moxt-ai/mobius-sdk/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MobiusClient, MobiusPageRequest, StaticMobiusCredentialProvider } from "../src/index.ts";

const recordedAt = "2026-10-07T00:00:00.000Z";

function event(sessionId: string, eventId: string): SessionEvent {
    return {
        eventId,
        payload: {
            content: { text: eventId, type: "text" },
            messageId: "message-1",
            sessionUpdate: "agent_message_chunk",
        },
        recordedAt,
        sessionGenerationId: "session-generation-1",
        sessionId,
        type: "acp",
    };
}

describe("Session Event Log V2 SDK", () => {
    const servers: ReturnType<typeof createServer>[] = [];

    afterEach(async () => {
        await Promise.all(
            servers.map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        servers.length = 0;
    });

    it("Given a V2 event page and external content, When a consumer uses the explicit SDK APIs, Then raw pages and content reads cross the production HTTP boundary unchanged", async () => {
        const sourceEvent = event("source-session", "source-event-1");
        const received: Array<{ readonly method: string; readonly path: string }> = [];
        const externalImage: ExternalImageContentBlock = {
            byteLength: 3,
            imageKey: "a".repeat(64),
            mimeType: "image/png",
            type: "external_image",
        };
        const server = createServer((request: IncomingMessage, response: ServerResponse) => {
            const path = request.url ?? "";
            received.push({ method: request.method ?? "", path });
            if (path.includes("/files/content")) {
                response.setHeader("content-type", "image/png");
                response.setHeader("last-modified", recordedAt);
                response.setHeader("x-mobius-byte-length", "3");
                response.setHeader("x-mobius-file-name", "image");
                response.end(Buffer.from([1, 2, 3]));
            } else if (path.includes("/events-v2")) {
                response.setHeader("content-type", "application/json");
                response.end(
                    JSON.stringify({
                        sessionGenerationId: "session-generation-1",
                        events: [sourceEvent],
                        nextCursor: null,
                        tailCursor: sourceEvent.eventId,
                        truncated: false,
                        version: 2,
                    }),
                );
            } else {
                response.setHeader("content-type", "application/json");
                response.statusCode = 404;
                response.end(JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
            }
        });
        servers.push(server);
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Expected an IP server address");
        }
        const client = new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider("test-credential"),
            endpoint: `http://127.0.0.1:${address.port}`,
            projectId: "project-1",
        });
        const signal = new AbortController().signal;

        try {
            expect(await client.events.list("source-session", new MobiusPageRequest(500, ""), signal)).toEqual({
                sessionGenerationId: "session-generation-1",
                events: [sourceEvent],
                nextCursor: null,
                tailCursor: sourceEvent.eventId,
                truncated: false,
                version: 2,
            });
            expect(await client.sessions.readExternalContent("source-session", externalImage, signal)).toMatchObject({
                bytes: Uint8Array.of(1, 2, 3),
                mediaType: "image/png",
                name: "image",
            });
        } finally {
            client.close();
        }

        expect(received).toEqual([
            {
                method: "GET",
                path: "/mobius/api/v1/projects/project-1/sessions/source-session/events-v2?limit=500",
            },
            {
                method: "GET",
                path: `/mobius/api/v1/projects/project-1/sessions/source-session/files/content?maxBytes=3&path=mobius-content%3Aimage%3A${"a".repeat(64)}`,
            },
        ]);
    });
});
