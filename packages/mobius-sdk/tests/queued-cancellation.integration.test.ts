import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { MobiusClient, StaticMobiusCredentialProvider } from "../src/index.ts";

const identity = { additionalDirectoryIds: [], agentId: "pi", directoryId: "default" };
const timestamp = "2026-10-29T00:00:00.000Z";

// Independently retained Relay contract from 826ab21d: no queuedCancellation capability,
// and /cancel reports cancelled even when the command won the execution race.
class LegacyQueueRelay implements AsyncDisposable {
    readonly cancellationEntered = Promise.withResolvers<void>();
    readonly releaseCancellation = Promise.withResolvers<void>();
    readonly #server;
    #state: "queued" | "cancelled" | "completed" = "queued";
    #head: "active" | null = "active";
    #holdCancellation: boolean;
    #content: readonly string[] = [];

    constructor(holdCancellation: boolean) {
        this.#holdCancellation = holdCancellation;
        this.#server = createServer((request, response) => {
            void this.#handle(request, response).catch((cause: unknown) =>
                response.destroy(cause instanceof Error ? cause : undefined),
            );
        });
    }

    readonly start = async (): Promise<MobiusClient> => {
        this.#server.listen(0, "127.0.0.1");
        await once(this.#server, "listening");
        const address = this.#server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Expected a loopback server address");
        }
        return new MobiusClient({
            credentialProvider: new StaticMobiusCredentialProvider("legacy-session-credential"),
            endpoint: `http://127.0.0.1:${address.port}`,
            projectId: "project-1",
        });
    };

    readonly completeWork = (): void => {
        this.#head = null;
        this.#content = ["ACTIVE_REPLY"];
        if (this.#state === "queued") {
            this.#state = "completed";
            this.#content = [...this.#content, "OLD_QUEUED_REPLY"];
        }
    };

    readonly #handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const url = new URL(request.url ?? "/", "http://legacy.invalid");
        response.setHeader("content-type", "application/json");
        if (request.headers.authorization !== "Bearer legacy-session-credential") {
            response.writeHead(401).end(JSON.stringify({ error: { code: "unauthorized", message: "Unauthorized" } }));
            return;
        }
        if (request.method === "GET" && url.pathname.endsWith("/active-turn")) {
            response.end(
                JSON.stringify({
                    action: "active-turn",
                    kind: "native.session.result",
                    requestId: "legacy-snapshot",
                    sessionId: "session-1",
                    targetSessionId: "session-1",
                    queued:
                        this.#state === "queued"
                            ? [{ commandId: "queued", prompt: "OLD_QUEUED_REPLY", attachments: [] }]
                            : [],
                    turn:
                        this.#head === null
                            ? null
                            : {
                                  commandId: this.#head,
                                  epoch: "active-epoch",
                                  interaction: null,
                                  sequence: 0,
                                  state: "running",
                              },
                    command:
                        this.#state === "queued"
                            ? { state: "accepted" }
                            : {
                                  state: "completed",
                                  stopReason: this.#state === "cancelled" ? "cancelled" : "end_turn",
                              },
                }),
            );
            return;
        }
        if (request.method === "POST" && url.pathname.endsWith("/turns/queued/cancel")) {
            let encoded = "";
            for await (const chunk of request) {
                encoded += String(chunk);
            }
            const body: unknown = JSON.parse(encoded);
            if (
                typeof body !== "object" ||
                body === null ||
                Reflect.get(body, "idempotencyKey") !== "edit-1" ||
                Object.keys(body).length !== 1
            ) {
                response
                    .writeHead(400)
                    .end(
                        JSON.stringify({ error: { code: "invalid_request", message: "Invalid legacy cancellation" } }),
                    );
                return;
            }
            this.cancellationEntered.resolve();
            if (this.#holdCancellation) {
                await this.releaseCancellation.promise;
            }
            if (this.#state === "queued") {
                this.#state = "cancelled";
            }
            response.end(
                JSON.stringify({
                    acceptedAt: timestamp,
                    bindingId: "workspace",
                    idempotencyKey: "edit-1",
                    request: { content: "", kind: "prompt", sessionConfigurations: [] },
                    sessionId: "session-1",
                    state: { cancelledAt: timestamp, kind: "cancelled" },
                    turnId: "queued",
                }),
            );
            return;
        }
        if (request.method === "GET" && url.pathname === "/observed-output") {
            response.end(JSON.stringify(this.#content));
            return;
        }
        response.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "Unknown legacy route" } }));
    };

    readonly output = async (): Promise<unknown> => {
        const address = this.#server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Legacy Relay is not listening");
        }
        return await (
            await fetch(`http://127.0.0.1:${address.port}/observed-output`, {
                headers: { authorization: "Bearer legacy-session-credential" },
                signal: AbortSignal.timeout(5_000),
            })
        ).json();
    };

    async [Symbol.asyncDispose](): Promise<void> {
        this.releaseCancellation.resolve();
        await new Promise<void>((resolve, reject) =>
            this.#server.close((error) => (error === undefined ? resolve() : reject(error))),
        );
    }
}

afterEach(() => vi.useRealTimers());

test("Given an older Relay and Runtime, When the new SDK withdraws a queued prompt, Then the legacy request still removes it without running its content", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(timestamp));
    await using relay = new LegacyQueueRelay(false);
    const client = await relay.start();
    try {
        await client.turns.cancelQueued(
            "session-1",
            "queued",
            { ...identity, idempotencyKey: "edit-1" },
            AbortSignal.timeout(5_000),
        );
        relay.completeWork();
        expect(await relay.output()).toEqual(["ACTIVE_REPLY"]);
        expect(
            await client.sessions.readSessionExecution("session-1", identity, AbortSignal.timeout(5_000), "queued"),
        ).toMatchObject({
            queued: [],
            command: { state: "completed", stopReason: "cancelled" },
        });
    } finally {
        client.close();
    }
});

test("Given an older Relay that labels a completed prompt cancelled, When execution wins the edit race, Then the new SDK reports withdrawal unconfirmed instead of allowing a duplicate edit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(timestamp));
    await using relay = new LegacyQueueRelay(true);
    const client = await relay.start();
    try {
        const withdrawal = client.turns.cancelQueued(
            "session-1",
            "queued",
            { ...identity, idempotencyKey: "edit-1" },
            AbortSignal.timeout(5_000),
        );
        const rejected = expect(withdrawal).rejects.toMatchObject({ code: "queued_cancellation_unconfirmed" });
        await relay.cancellationEntered.promise;
        relay.completeWork();
        relay.releaseCancellation.resolve();
        await rejected;
        expect(await relay.output()).toEqual(["ACTIVE_REPLY", "OLD_QUEUED_REPLY"]);
    } finally {
        client.close();
    }
});
