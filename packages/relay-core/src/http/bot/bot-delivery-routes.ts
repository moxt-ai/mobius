import { Hono } from "hono";
import { BotDeliveryError, type BotDeliveryErrorCode } from "../../entity/bot/bot-delivery-error.ts";
import { RequestBodyError, readBoundedUtf8Body } from "../../infra/bounded-request-body.ts";
import type { BotDeliveryService, OutboundDelivery } from "../../service/bot/bot-delivery-service.ts";

function deliveryErrorStatus(code: BotDeliveryErrorCode): number {
    switch (code) {
        case "connection_storage_unavailable":
            return 503;
        case "idempotency_conflict":
        case "revision_conflict":
            return 409;
        case "queue_full":
            return 429;
        case "invalid_request":
            return 400;
        case "connection_not_found":
            return 404;
        default: {
            const unreachable: never = code;
            return unreachable;
        }
    }
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
        throw new BotDeliveryError("invalid_request", "The connection operation is invalid");
    }
}
function text(value: Readonly<Record<string, unknown>>, key: string, maximum = 10_000): string {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0 || field.length > maximum) {
        throw new BotDeliveryError("invalid_request", `The ${key} field is invalid`);
    }
    return field;
}
function integer(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new BotDeliveryError("invalid_request", `The ${key} field is invalid`);
    }
    return field;
}
function strings(value: Readonly<Record<string, unknown>>, key: string): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.length > 1_000 || field.some((entry) => typeof entry !== "string")) {
        throw new BotDeliveryError("invalid_request", `The ${key} field is invalid`);
    }
    return field.filter((entry) => typeof entry === "string");
}
async function body(request: Request): Promise<Readonly<Record<string, unknown>>> {
    let encoded: string;
    try {
        encoded = await readBoundedUtf8Body(request, 64 * 1024);
    } catch (cause) {
        if (cause instanceof RequestBodyError) {
            throw new BotDeliveryError("invalid_request", "The connection operation is invalid", { cause });
        }
        throw cause;
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotDeliveryError("invalid_request", "The connection operation is invalid", { cause });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new BotDeliveryError("invalid_request", "The connection operation must be an object");
    }
    return Object.fromEntries(Object.entries(value));
}
function outbound(value: Readonly<Record<string, unknown>>): OutboundDelivery {
    exact(value, [
        "acceptedAt",
        "behaviorRevisionId",
        "bindingId",
        "bindingRevision",
        "botId",
        "connectionId",
        "conversationId",
        "deliveryTargetId",
        "executionId",
        "expiresAt",
        "idempotencyKey",
        "outboundMessageId",
        "text",
        "turnId",
    ]);
    return {
        acceptedAt: text(value, "acceptedAt"),
        behaviorRevisionId: text(value, "behaviorRevisionId"),
        bindingId: text(value, "bindingId"),
        bindingRevision: integer(value, "bindingRevision"),
        botId: text(value, "botId"),
        connectionId: text(value, "connectionId"),
        conversationId: text(value, "conversationId"),
        deliveryTargetId: text(value, "deliveryTargetId"),
        executionId: text(value, "executionId"),
        expiresAt: text(value, "expiresAt"),
        idempotencyKey: text(value, "idempotencyKey"),
        outboundMessageId: text(value, "outboundMessageId"),
        text: text(value, "text"),
        turnId: text(value, "turnId"),
    };
}

export function createBotDeliveryRoutes(service: BotDeliveryService) {
    return new Hono()
        .basePath("/internal/bot-connections")
        .use("*", async (c, next) => {
            if (c.req.method !== "POST") {
                return new Response(null, { status: 405 });
            }
            return await next();
        })
        .onError((error, c) => {
            c.req.raw.signal.throwIfAborted();
            if (error instanceof BotDeliveryError) {
                return Response.json(
                    { error: { code: error.code, message: error.message } },
                    { status: deliveryErrorStatus(error.code) },
                );
            }
            console.error("Bot connection operation failed", error);
            return Response.json(
                {
                    error: {
                        code: "connection_storage_unavailable",
                        message: "The Bot connection storage is unavailable",
                    },
                },
                { status: 503 },
            );
        })
        .post("/enqueue", async (c) => c.json(await service.enqueue(outbound(await body(c.req.raw)), c.req.raw.signal)))
        .post("/read", async (c) => {
            const value = await body(c.req.raw);
            exact(value, ["activeDeliveryTargetIds", "after", "connectionId", "limit", "now"]);
            return c.json(
                service.read(
                    text(value, "connectionId"),
                    integer(value, "after"),
                    integer(value, "limit"),
                    integer(value, "now"),
                    strings(value, "activeDeliveryTargetIds"),
                ),
            );
        })
        .post("/delivered", async (c) => {
            const value = await body(c.req.raw);
            exact(value, ["claimId", "connectionId", "now", "outboundMessageId"]);
            return c.json(
                service.acknowledge(
                    text(value, "connectionId"),
                    text(value, "outboundMessageId"),
                    text(value, "claimId"),
                    "delivered",
                    "",
                    integer(value, "now"),
                    integer(value, "now"),
                ),
            );
        })
        .post("/retryable-failure", async (c) => {
            const value = await body(c.req.raw);
            exact(value, ["claimId", "code", "connectionId", "now", "outboundMessageId", "retryAt"]);
            return c.json(
                service.acknowledge(
                    text(value, "connectionId"),
                    text(value, "outboundMessageId"),
                    text(value, "claimId"),
                    "retryable_failed",
                    text(value, "code", 128),
                    integer(value, "now"),
                    integer(value, "retryAt"),
                ),
            );
        })
        .post("/terminal-failure", async (c) => {
            const value = await body(c.req.raw);
            exact(value, ["claimId", "code", "connectionId", "now", "outboundMessageId"]);
            return c.json(
                service.acknowledge(
                    text(value, "connectionId"),
                    text(value, "outboundMessageId"),
                    text(value, "claimId"),
                    "terminal_failed",
                    text(value, "code", 128),
                    integer(value, "now"),
                    integer(value, "now"),
                ),
            );
        })
        .notFound(() =>
            Response.json(
                { error: { code: "connection_not_found", message: "The connection operation does not exist" } },
                { status: 404 },
            ),
        );
}
