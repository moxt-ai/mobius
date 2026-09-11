import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { MobiusHttpTransport } from "@moxt-ai/mobius-sdk/server";
import { DemoPlatformService } from "./demo-platform-service.ts";

const MAXIMUM_REQUEST_BYTES = 16 * 1024;
const OPERATION_TIMEOUT_MILLISECONDS = 20_000;

class FetchTransport implements MobiusHttpTransport {
    readonly fetch = async (request: Request): Promise<Response> => await fetch(request);
}

class DemoApiError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, message: string, status: number, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.status = status;
        this.name = "DemoApiError";
    }
}

function requiredEnvironment(name: string): string {
    const value = process.env[name]?.trim();
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function environmentPort(name: string): number {
    const value = requiredEnvironment(name);
    if (!/^\d+$/.test(value)) {
        throw new Error(`${name} must be an integer TCP port`);
    }
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`${name} must be between 1 and 65535`);
    }
    return port;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
    const encoded = JSON.stringify(value);
    response.writeHead(status, {
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(encoded).toString(),
        "content-security-policy": "default-src 'none'",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
    });
    response.end(encoded);
}

async function readJson(request: IncomingMessage, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of request) {
        signal.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.byteLength;
        if (byteLength > MAXIMUM_REQUEST_BYTES) {
            throw new DemoApiError("request_too_large", "The demo request is too large", 413);
        }
        chunks.push(bytes);
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (cause) {
        throw new DemoApiError("invalid_request", "The demo request body must be JSON", 400, { cause });
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        throw new DemoApiError("invalid_request", "The demo request body must be an object", 400);
    }
    return Object.freeze(Object.fromEntries(Object.entries(decoded)));
}

function labelFromRequest(body: Readonly<Record<string, unknown>>): string {
    if (Object.keys(body).some((key) => key !== "label") || typeof body["label"] !== "string") {
        throw new DemoApiError("invalid_request", "The provision request requires one label", 400);
    }
    return body["label"];
}

function operationSignal(request: IncomingMessage): AbortSignal {
    const disconnected = new AbortController();
    request.once("aborted", () => disconnected.abort(new Error("The browser disconnected")));
    return AbortSignal.any([disconnected.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MILLISECONDS)]);
}

const apiPort = environmentPort("MOBIUS_DEMO_API_PORT");
const platformEndpoint = requiredEnvironment("MOBIUS_DEMO_PLATFORM_ENDPOINT");
const runtimeStateDirectory = requiredEnvironment("MOBIUS_DEMO_RUNTIME_STATE_DIRECTORY");
const demoWorkspace = requiredEnvironment("MOBIUS_DEMO_WORKSPACE");
const service = new DemoPlatformService({
    authenticationProviderId: "demo-local",
    developerCredential: requiredEnvironment("MOBIUS_DEMO_DEVELOPER_TOKEN"),
    endpoint: platformEndpoint,
    transport: new FetchTransport(),
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${apiPort.toString()}`);
    const method = request.method ?? "GET";
    const signal = operationSignal(request);

    if (method === "GET" && url.pathname === "/demo-api/health") {
        sendJson(response, 200, { platformEndpoint, status: "ready" });
        return;
    }
    if (method === "POST" && url.pathname === "/demo-api/provision") {
        const body = await readJson(request, signal);
        sendJson(response, 201, await service.provision(labelFromRequest(body), signal));
        return;
    }
    if (method === "POST" && url.pathname === "/demo-api/app-credentials/verify") {
        sendJson(response, 200, await service.verifyAppCredentialLifecycle(signal));
        return;
    }
    if (method === "POST" && url.pathname === "/demo-api/runtime-pairings") {
        const pairing = await service.createRuntimePairing(signal);
        const command = [
            "env",
            `MOBIUS_STATE_DIRECTORY=${runtimeStateDirectory}`,
            "pnpm",
            "mobius",
            "pair",
            "--url",
            platformEndpoint,
            "--pairing",
            pairing.pairingId,
            "--code",
            pairing.pairingCode,
            "--workspace",
            demoWorkspace,
        ]
            .map((argument) => JSON.stringify(argument))
            .join(" ");
        sendJson(response, 201, { ...pairing, command });
        return;
    }
    if (method === "GET" && url.pathname === "/demo-api/runtime-pairing") {
        sendJson(response, 200, await service.readRuntimePairing(signal));
        return;
    }
    if (method === "POST" && url.pathname === "/demo-api/bots") {
        sendJson(response, 201, await service.createBot(signal));
        return;
    }
    if (method === "POST" && url.pathname === "/demo-api/conversation-access") {
        const access = await service.createConversationAccess(signal);
        sendJson(response, 201, { ...access, platformEndpoint });
        return;
    }
    throw new DemoApiError("not_found", "The demo API route was not found", 404);
}

const server = createServer((request, response) => {
    void route(request, response).catch((cause: unknown) => {
        if (response.headersSent) {
            response.destroy();
            return;
        }
        if (cause instanceof DemoApiError) {
            sendJson(response, cause.status, { error: { code: cause.code, message: cause.message } });
            return;
        }
        const code =
            typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
                ? cause.code
                : "demo_operation_failed";
        const message = cause instanceof Error ? cause.message : "The demo operation failed";
        process.stderr.write(`Platform demo API failure [${code}]: ${message}\n`);
        sendJson(response, 500, { error: { code, message } });
    });
});

server.listen(apiPort, "127.0.0.1", () => {
    process.stdout.write(`Platform demo API listening on http://127.0.0.1:${apiPort.toString()}\n`);
});

const shutdown = (): void => {
    server.close((error) => {
        if (error !== undefined) {
            process.stderr.write(`Platform demo API shutdown failed: ${error.message}\n`);
            process.exitCode = 1;
        }
    });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
