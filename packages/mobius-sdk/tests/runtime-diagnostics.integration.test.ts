import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MobiusValidationError } from "../src/errors.ts";
import { MobiusClient, StaticMobiusCredentialProvider } from "../src/index.ts";

describe("Runtime diagnostics SDK", () => {
    const servers: ReturnType<typeof createServer>[] = [];

    afterEach(async () => {
        await Promise.all(
            servers.map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        servers.length = 0;
    });

    // @no-uc: Technical regression; the diagnostics route must be reachable through the SDK at the production HTTP boundary.
    it("Given a Relay that returns a Runtime's local diagnostic log, When a consumer reads it through the SDK, Then the report crosses the production HTTP boundary as correlation metadata", async () => {
        const report = {
            entries: [
                {
                    code: "acp_agent_error",
                    commandId: "command-1",
                    event: "session_prompt_failed",
                    sessionId: "session-1",
                    timestamp: "2026-10-21T00:00:00.000Z",
                },
                { exitCode: "137", kind: "worker_exited", pid: "4242", signal: "SIGKILL" },
            ],
            kind: "runtime.diagnostics.result",
            requestId: "report-1",
            truncated: false,
            version: "0.0.272",
        };
        const received: Array<{ readonly method: string; readonly path: string }> = [];
        const server = createServer((request: IncomingMessage, response: ServerResponse) => {
            received.push({ method: request.method ?? "", path: request.url ?? "" });
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(report));
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
            expect(await client.runtimes.readDiagnostics("runtime-1", signal)).toEqual(report);
        } finally {
            client.close();
        }
        expect(received).toEqual([
            { method: "GET", path: "/mobius/api/v1/projects/project-1/runtimes/runtime-1/diagnostics" },
        ]);
    });

    // @no-uc: Technical regression; an unvalidated identifier must be rejected before any request path is built.
    it("Given an invalid Runtime identifier, When a consumer reads diagnostics, Then the SDK rejects it before making a request", async () => {
        const received: string[] = [];
        const server = createServer((request: IncomingMessage, response: ServerResponse) => {
            received.push(request.url ?? "");
            response.setHeader("content-type", "application/json");
            response.end("{}");
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
            await expect(client.runtimes.readDiagnostics("runtime 1/../etc", signal)).rejects.toBeInstanceOf(
                MobiusValidationError,
            );
        } finally {
            client.close();
        }
        // An unvalidated identifier would reach the path builder; the Relay must
        // never receive a request whose path was assembled from it.
        expect(received).toEqual([]);
    });
});
