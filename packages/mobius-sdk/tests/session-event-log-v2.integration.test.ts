import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ExternalImageContentBlockV2, MobiusSessionExportV2, SessionEventV2 } from "@moxt-ai/mobius-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
    MobiusClient,
    MobiusPageRequest,
    MobiusSessionImportBinding,
    StaticMobiusCredentialProvider,
} from "../src/index.ts";

const recordedAt = "2026-10-07T00:00:00.000Z";

function event(sessionId: string, eventId: string, position: string): SessionEventV2 {
    return {
        eventId,
        payload: {
            content: { text: eventId, type: "text" },
            messageId: "message-1",
            sessionUpdate: "agent_message_chunk",
        },
        position,
        provenance: { kind: "original" },
        recordedAt,
        sessionId,
        type: "acp",
    };
}

function session(sessionId: string) {
    return {
        agentId: "agent-1",
        createdAt: recordedAt,
        createdBy: "user-1",
        defaultBinding: {
            agentRef: "agent-1",
            bindingId: "binding-1",
            configRevision: 1,
            createdAt: recordedAt,
            runtimeId: "runtime-1",
            sessionId,
            workspaceRef: "workspace-1",
        },
        hasNativeHistory: true,
        lastCommittedSeq: "1",
        policy: {
            contentLimitBytes: 1_000_000,
            hotEventLimit: 10_000,
            idempotencyRetentionMilliseconds: 60_000,
            level: "full",
            retentionMilliseconds: 60_000,
        },
        projectId: "project-1",
        runtimeId: "runtime-1",
        sessionId,
        lifecycle: { kind: "ready" },
        title: "Copied session",
        updatedAt: recordedAt,
    };
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

describe("Session Event Log V2 SDK", () => {
    const servers: ReturnType<typeof createServer>[] = [];

    afterEach(async () => {
        await Promise.all(
            servers.map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        servers.length = 0;
    });

    it("Given a V2 export and immutable fork boundary, When a consumer uses the explicit SDK APIs, Then raw pages and copy requests cross the production HTTP boundary unchanged", async () => {
        const sourceEvent = event("source-session", "source-event-1", "1");
        const exported: MobiusSessionExportV2 = {
            formatVersion: "2",
            session: {
                binding: { bindingId: "binding-1", runtimeId: "runtime-1" },
                events: [sourceEvent],
                sessionId: "source-session",
                truncated: false,
            },
        };
        const received: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
        const externalImage: ExternalImageContentBlockV2 = {
            byteLength: 3,
            imageKey: "a".repeat(64),
            mimeType: "image/png",
            type: "external_image",
        };
        const server = createServer((request: IncomingMessage, response: ServerResponse) => {
            void (async () => {
                const path = request.url ?? "";
                const body = request.method === "POST" ? await requestBody(request) : null;
                received.push({ body, method: request.method ?? "", path });
                if (path.includes("/files/content")) {
                    response.setHeader("content-type", "image/png");
                    response.setHeader("last-modified", recordedAt);
                    response.setHeader("x-mobius-byte-length", "3");
                    response.setHeader("x-mobius-file-name", "image");
                    response.end(Buffer.from([1, 2, 3]));
                } else if (path.endsWith("/export-v2")) {
                    response.setHeader("content-type", "application/json");
                    response.end(JSON.stringify(exported));
                } else if (path.includes("/events-v2")) {
                    response.setHeader("content-type", "application/json");
                    response.end(
                        JSON.stringify({
                            daemonGenerationId: "daemon-generation-1",
                            events: [sourceEvent],
                            nextCursor: null,
                            tailCursor: sourceEvent.eventId,
                            truncated: false,
                            version: 2,
                        }),
                    );
                } else if (path.endsWith("/session-imports-v2")) {
                    response.setHeader("content-type", "application/json");
                    response.end(JSON.stringify(session("imported-session")));
                } else if (path.endsWith("/forks-v2")) {
                    response.setHeader("content-type", "application/json");
                    response.end(JSON.stringify(session("forked-session")));
                } else {
                    response.setHeader("content-type", "application/json");
                    response.statusCode = 404;
                    response.end(JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
                }
            })().catch((cause: unknown) => {
                response.statusCode = 500;
                response.end(JSON.stringify({ error: { code: "test_failure", message: String(cause) } }));
            });
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
        const binding = new MobiusSessionImportBinding("binding-2", "runtime-1", "agent-1", "workspace-1");

        try {
            expect(await client.events.listV2("source-session", new MobiusPageRequest(50, ""), signal)).toEqual({
                daemonGenerationId: "daemon-generation-1",
                events: [sourceEvent],
                nextCursor: null,
                tailCursor: sourceEvent.eventId,
                truncated: false,
                version: 2,
            });
            expect(await client.sessions.exportV2("source-session", signal)).toEqual(exported);
            expect(await client.sessions.readExternalContent("source-session", externalImage, signal)).toMatchObject({
                bytes: Uint8Array.of(1, 2, 3),
                mediaType: "image/png",
                name: "image",
            });
            expect((await client.sessions.importV2(exported, binding, signal)).sessionId).toBe("imported-session");
            expect(
                (
                    await client.sessions.forkRecordedV2(
                        "source-session",
                        { targetBinding: binding, throughEventId: sourceEvent.eventId },
                        signal,
                    )
                ).sessionId,
            ).toBe("forked-session");
        } finally {
            client.close();
        }

        expect(received).toEqual([
            {
                body: null,
                method: "GET",
                path: "/mobius/api/v1/projects/project-1/sessions/source-session/events-v2?limit=50",
            },
            {
                body: null,
                method: "GET",
                path: "/mobius/api/v1/projects/project-1/sessions/source-session/export-v2",
            },
            {
                body: null,
                method: "GET",
                path: `/mobius/api/v1/projects/project-1/sessions/source-session/files/content?maxBytes=3&path=mobius-content%3Aimage%3A${"a".repeat(64)}`,
            },
            {
                body: { ...exported, targetBinding: { ...binding } },
                method: "POST",
                path: "/mobius/api/v1/projects/project-1/session-imports-v2",
            },
            {
                body: { targetBinding: { ...binding }, throughEventId: sourceEvent.eventId },
                method: "POST",
                path: "/mobius/api/v1/projects/project-1/sessions/source-session/forks-v2",
            },
        ]);
    });
});
