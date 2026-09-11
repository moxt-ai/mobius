import { Hono } from "hono";
import * as v from "valibot";
import type { BotDeliveryService } from "../../service/bot/bot-delivery-service.ts";
import { botDeliveryBodyParser } from "../middleware/bot-delivery-body-parser.ts";
import { botDeliveryErrorMiddleware } from "../middleware/bot-error-middleware.ts";
import { rethrowHonoError } from "../middleware/error-response-middleware.ts";

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(10_000));
const integer = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const code = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

const enqueueSchema = v.strictObject({
    acceptedAt: text,
    behaviorRevisionId: text,
    bindingId: text,
    bindingRevision: integer,
    botId: text,
    connectionId: text,
    conversationId: text,
    deliveryTargetId: text,
    executionId: text,
    expiresAt: text,
    idempotencyKey: text,
    outboundMessageId: text,
    text,
    turnId: text,
});
const readSchema = v.strictObject({
    activeDeliveryTargetIds: v.pipe(v.array(v.string()), v.maxLength(1_000)),
    after: integer,
    connectionId: text,
    limit: integer,
    now: integer,
});
const deliveredSchema = v.strictObject({
    claimId: text,
    connectionId: text,
    now: integer,
    outboundMessageId: text,
});
const retryableFailureSchema = v.strictObject({
    ...deliveredSchema.entries,
    code,
    retryAt: integer,
});
const terminalFailureSchema = v.strictObject({ ...deliveredSchema.entries, code });

export function createBotDeliveryRoutes(service: BotDeliveryService) {
    return new Hono()
        .basePath("/internal/bot-connections")
        .onError(rethrowHonoError)
        .use("*", botDeliveryErrorMiddleware())
        .use("*", async (c, next) => {
            if (c.req.method !== "POST") {
                return new Response(null, { status: 405 });
            }
            return await next();
        })
        .post("/enqueue", botDeliveryBodyParser(enqueueSchema), async (c) =>
            c.json(await service.enqueue(c.req.valid("json"), c.req.raw.signal)),
        )
        .post("/read", botDeliveryBodyParser(readSchema), (c) => {
            const value = c.req.valid("json");
            return c.json(
                service.read(value.connectionId, value.after, value.limit, value.now, value.activeDeliveryTargetIds),
            );
        })
        .post("/delivered", botDeliveryBodyParser(deliveredSchema), (c) => {
            const value = c.req.valid("json");
            return c.json(
                service.acknowledge(
                    value.connectionId,
                    value.outboundMessageId,
                    value.claimId,
                    "delivered",
                    "",
                    value.now,
                    value.now,
                ),
            );
        })
        .post("/retryable-failure", botDeliveryBodyParser(retryableFailureSchema), (c) => {
            const value = c.req.valid("json");
            return c.json(
                service.acknowledge(
                    value.connectionId,
                    value.outboundMessageId,
                    value.claimId,
                    "retryable_failed",
                    value.code,
                    value.now,
                    value.retryAt,
                ),
            );
        })
        .post("/terminal-failure", botDeliveryBodyParser(terminalFailureSchema), (c) => {
            const value = c.req.valid("json");
            return c.json(
                service.acknowledge(
                    value.connectionId,
                    value.outboundMessageId,
                    value.claimId,
                    "terminal_failed",
                    value.code,
                    value.now,
                    value.now,
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
