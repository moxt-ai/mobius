import { Buffer } from "node:buffer";
import { appendFile, mkdtemp } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttp2Server, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface RawCursorMessage {
    readonly bodyHex: string;
    readonly headers: Readonly<Record<string, string | readonly string[]>>;
    readonly method: string;
    readonly protocol: "control-http1" | "agent-http2";
    readonly stage: "request" | "request-data" | "response" | "response-data";
    readonly status?: number;
    readonly url: string;
}

const accessToken = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6Im1vYml1cy1lMmUifQ.";
const modelId = "gpt-5";
const cursorResponse = "Response from Cursor CLI through the local fake provider";
const shellCommand = "printf cursor-agent-daemon-e2e";
const toolCallId = "cursor-e2e-shell";
const modelCallId = "cursor-e2e-model-call";
const execId = "cursor-e2e-exec";

function varint(value: number): Uint8Array {
    const bytes: number[] = [];
    let remaining = value;
    do {
        const byte = remaining & 0x7f;
        remaining = Math.floor(remaining / 128);
        bytes.push(remaining === 0 ? byte : byte | 0x80);
    } while (remaining !== 0);
    return Uint8Array.from(bytes);
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
    return Uint8Array.from(values.flatMap((value) => [...value]));
}

function lengthDelimited(field: number, value: Uint8Array): Uint8Array {
    return concat(varint(field * 8 + 2), varint(value.length), value);
}

function uintField(field: number, value: number): Uint8Array {
    return concat(varint(field * 8), varint(value));
}

function connectEnvelope(payload: Uint8Array, flags = 0): Uint8Array {
    const envelope = new Uint8Array(payload.length + 5);
    envelope[0] = flags;
    envelope[1] = (payload.length >>> 24) & 0xff;
    envelope[2] = (payload.length >>> 16) & 0xff;
    envelope[3] = (payload.length >>> 8) & 0xff;
    envelope[4] = payload.length & 0xff;
    envelope.set(payload, 5);
    return envelope;
}

function hex(value: Uint8Array): string {
    return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readConnectEnvelopes(buffer: Uint8Array): {
    readonly messages: readonly Uint8Array[];
    readonly rest: Uint8Array;
} {
    const messages: Uint8Array[] = [];
    let offset = 0;
    while (buffer.length - offset >= 5) {
        const length =
            ((buffer[offset + 1] ?? 0) << 24) |
            ((buffer[offset + 2] ?? 0) << 16) |
            ((buffer[offset + 3] ?? 0) << 8) |
            (buffer[offset + 4] ?? 0);
        if (buffer.length - offset - 5 < length) {
            break;
        }
        if ((buffer[offset] ?? 0) === 0) {
            messages.push(buffer.subarray(offset + 5, offset + 5 + length));
        }
        offset += 5 + length;
    }
    return { messages, rest: buffer.subarray(offset) };
}

function stringField(field: number, value: string): Uint8Array {
    return lengthDelimited(field, new TextEncoder().encode(value));
}

function modelDetails(): Uint8Array {
    return concat(
        stringField(1, modelId),
        stringField(3, modelId),
        stringField(4, "GPT-5"),
        stringField(5, "GPT-5"),
        stringField(6, modelId),
    );
}

function shellToolCall(): Uint8Array {
    return lengthDelimited(1, lengthDelimited(1, stringField(1, shellCommand)));
}

function toolUpdate(field: 2 | 3): Uint8Array {
    const update = concat(stringField(1, toolCallId), lengthDelimited(2, shellToolCall()), stringField(3, modelCallId));
    return lengthDelimited(1, lengthDelimited(field, update));
}

function shellExecutionRequest(): Uint8Array {
    const shellArgs = concat(
        stringField(1, shellCommand),
        stringField(2, process.cwd()),
        uintField(3, 10_000),
        stringField(4, toolCallId),
        lengthDelimited(8, new Uint8Array()),
    );
    const execution = concat(uintField(1, 1), lengthDelimited(2, shellArgs), stringField(15, execId));
    return lengthDelimited(2, execution);
}

function textUpdate(text: string): Uint8Array {
    return lengthDelimited(1, lengthDelimited(1, stringField(1, text)));
}

function turnEndedUpdate(): Uint8Array {
    return lengthDelimited(1, lengthDelimited(14, new Uint8Array()));
}

function redactHeader(name: string, value: string | readonly string[]): string | readonly string[] {
    return /^(?:authorization|cookie|x-api-key|x-blob-encryption-key)$/iu.test(name) ? "[redacted]" : value;
}

function redactHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string | readonly string[]>> {
    return Object.fromEntries(
        Object.entries(headers).flatMap(([name, value]) => {
            if (value === undefined) {
                return [];
            }
            return [[name, redactHeader(name, value)]];
        }),
    );
}

export class FakeCursorProvider implements AsyncDisposable {
    static readonly response = cursorResponse;
    readonly agentOrigin: string;
    readonly origin: string;
    readonly tracePath: string;
    readonly #close: () => Promise<void>;
    readonly #messages: RawCursorMessage[];

    private constructor(
        origin: string,
        agentOrigin: string,
        tracePath: string,
        messages: RawCursorMessage[],
        close: () => Promise<void>,
    ) {
        this.agentOrigin = agentOrigin;
        this.origin = origin;
        this.tracePath = tracePath;
        this.#messages = messages;
        this.#close = close;
    }

    rawMessages(): readonly RawCursorMessage[] {
        return this.#messages;
    }

    static async start(): Promise<FakeCursorProvider> {
        const messages: RawCursorMessage[] = [];
        const traceDirectory = await mkdtemp(join(tmpdir(), "mobius-fake-cursor-"));
        const tracePath = join(traceDirectory, "messages.ndjson");
        let traceWrite: Promise<void> = Promise.resolve();
        const record = (message: RawCursorMessage): void => {
            messages.push(message);
            traceWrite = traceWrite.then(
                async () => await appendFile(tracePath, `${JSON.stringify(message)}\n`, { mode: 0o600 }),
            );
        };
        const server = createServer(async (request, response) => {
            const chunks: Uint8Array[] = [];
            for await (const chunk of request) {
                chunks.push(chunk as Uint8Array);
            }
            const body = Buffer.concat(chunks);
            const raw: RawCursorMessage = {
                bodyHex: body.toString("hex"),
                headers: redactHeaders(request.headers),
                method: request.method ?? "",
                protocol: "control-http1",
                stage: "request",
                url: request.url ?? "",
            };
            record(raw);
            const send = (
                status: number,
                contentType: string,
                responseBody: Uint8Array<ArrayBufferLike> = new Uint8Array(),
            ): void => {
                const responseHeaders = {
                    "content-length": responseBody.length.toString(),
                    "content-type": contentType,
                };
                record({
                    bodyHex: hex(responseBody),
                    headers: responseHeaders,
                    method: request.method ?? "",
                    protocol: "control-http1",
                    stage: "response",
                    status,
                    url: request.url ?? "",
                });
                response.writeHead(status, responseHeaders);
                response.end(responseBody);
            };

            if (request.method === "POST" && request.url === "/auth/exchange_user_api_key") {
                send(
                    200,
                    "application/json",
                    new TextEncoder().encode(JSON.stringify({ accessToken, refreshToken: "mobius-e2e-refresh" })),
                );
                return;
            }
            if (request.method === "POST" && request.url === "/aiserver.v1.AiService/GetUsableModels") {
                send(200, "application/proto", lengthDelimited(1, modelDetails()));
                return;
            }
            if (request.method === "POST" && request.url === "/aiserver.v1.AiService/GetDefaultModelForCli") {
                send(200, "application/proto", lengthDelimited(1, modelDetails()));
                return;
            }
            if (request.method === "POST" && request.url?.startsWith("/aiserver.v1.") === true) {
                send(200, "application/proto");
                return;
            }
            send(404, "application/octet-stream");
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            server.close();
            throw new Error("Fake Cursor control provider has no TCP address");
        }
        const agentServer = createHttp2Server();
        const agentSessions = new Set<ServerHttp2Session>();
        const agentStreams = new Set<ServerHttp2Stream>();
        agentServer.on("session", (session) => {
            agentSessions.add(session);
            session.once("close", () => agentSessions.delete(session));
        });
        agentServer.on("stream", (stream, headers) => {
            agentStreams.add(stream);
            const method = String(headers[":method"] ?? "");
            const url = String(headers[":path"] ?? "");
            const visibleHeaders = Object.fromEntries(
                Object.entries(headers).flatMap(([name, value]) => {
                    if (value === undefined || name.startsWith(":")) {
                        return [];
                    }
                    return [[name, redactHeader(name, String(value))]];
                }),
            );
            record({
                bodyHex: "",
                headers: visibleHeaders,
                method,
                protocol: "agent-http2",
                stage: "request",
                url,
            });
            if (method !== "POST" || url !== "/agent.v1.AgentService/Run") {
                stream.respond({ ":status": 404 });
                stream.end();
                return;
            }
            let requestBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
            let sentToolCall = false;
            let completed = false;
            const writeAgentMessage = (payload: Uint8Array, flags = 0): void => {
                const body = connectEnvelope(payload, flags);
                record({
                    bodyHex: hex(body),
                    headers: {},
                    method,
                    protocol: "agent-http2",
                    stage: "response-data",
                    url,
                });
                stream.write(body);
            };
            const sendToolCall = (): void => {
                writeAgentMessage(toolUpdate(2));
                writeAgentMessage(shellExecutionRequest());
            };
            const sendCompletion = (): void => {
                writeAgentMessage(toolUpdate(3));
                writeAgentMessage(textUpdate(cursorResponse));
                writeAgentMessage(turnEndedUpdate());
                const endStream = connectEnvelope(new TextEncoder().encode("{}"), 2);
                record({
                    bodyHex: hex(endStream),
                    headers: {},
                    method,
                    protocol: "agent-http2",
                    stage: "response-data",
                    url,
                });
                stream.end(endStream);
            };
            stream.on("data", (chunk: Buffer) => {
                const bytes = Buffer.from(chunk);
                record({
                    bodyHex: bytes.toString("hex"),
                    headers: {},
                    method,
                    protocol: "agent-http2",
                    stage: "request-data",
                    url,
                });
                requestBuffer = concat(requestBuffer, bytes);
                const parsed = readConnectEnvelopes(requestBuffer);
                requestBuffer = parsed.rest;
                for (const message of parsed.messages) {
                    const topLevelField = (message[0] ?? 0) >> 3;
                    if (topLevelField === 1 && !sentToolCall) {
                        sentToolCall = true;
                        sendToolCall();
                    } else if (topLevelField === 2 && sentToolCall && !completed) {
                        completed = true;
                        sendCompletion();
                    }
                }
            });
            stream.once("close", () => agentStreams.delete(stream));
            stream.once("error", () => agentStreams.delete(stream));

            const responseHeaders = {
                ":status": 200,
                "content-type": "application/connect+proto",
            } as const;
            stream.respond(responseHeaders);
            record({
                bodyHex: "",
                headers: { "content-type": responseHeaders["content-type"] },
                method,
                protocol: "agent-http2",
                stage: "response",
                status: 200,
                url,
            });
        });
        await new Promise<void>((resolve, reject) => {
            agentServer.once("error", reject);
            agentServer.listen(0, "127.0.0.1", resolve);
        });
        const agentAddress = agentServer.address();
        if (agentAddress === null || typeof agentAddress === "string") {
            agentServer.close();
            server.close();
            throw new Error("Fake Cursor agent provider has no TCP address");
        }
        const close = async (): Promise<void> => {
            server.closeAllConnections();
            for (const stream of agentStreams) {
                stream.destroy();
            }
            for (const session of agentSessions) {
                session.destroy();
            }
            await Promise.all([
                new Promise<void>((resolve, reject) =>
                    server.close((error) => (error === undefined ? resolve() : reject(error))),
                ),
                new Promise<void>((resolve, reject) =>
                    agentServer.close((error) => (error === undefined ? resolve() : reject(error))),
                ),
            ]);
            await traceWrite;
        };
        return new FakeCursorProvider(
            `http://127.0.0.1:${address.port.toString()}`,
            `http://127.0.0.1:${agentAddress.port.toString()}`,
            tracePath,
            messages,
            close,
        );
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.#close();
    }
}
