import {
    decodePromptImagesValue,
    decodePromptResourcesValue,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import {
    type ConversationPermission,
    ConversationPermission as Permission,
    SessionRuntimeError,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import * as v from "valibot";
import { bodyParser } from "../middleware/body-parser.ts";
import type { ConversationHttpBindings, ConversationHttpEnvironment } from "./conversation-http-environment.ts";
import { bearer } from "./conversation-request.ts";

const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 500;

const nonemptyStringSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const idempotencyKeySchema = v.pipe(
    nonemptyStringSchema,
    v.transform((value) => validateIdentifier(value, "idempotency_key")),
);
const directoryIdsSchema = v.pipe(
    v.array(v.string()),
    v.maxLength(16),
    v.transform((value) => value.map((entry) => validateIdentifier(entry, "directory_id"))),
    v.check((value) => new Set(value).size === value.length),
    v.transform((value) => Object.freeze(value)),
);
const artifactIdsSchema = v.pipe(
    v.array(v.string()),
    v.maxLength(16),
    v.transform((value) => value.map((entry) => validateIdentifier(entry, "artifact_id"))),
    v.check((value) => new Set(value).size === value.length),
    v.transform((value) => Object.freeze(value)),
);
const emptyBodySchema = v.strictObject({});
const configurationSchema = v.strictObject({
    additionalDirectoryIds: directoryIdsSchema,
    booleanValue: v.boolean(),
    configId: nonemptyStringSchema,
    idempotencyKey: idempotencyKeySchema,
    value: v.pipe(v.string(), v.maxLength(500)),
    valueType: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
});
const messageEntries = {
    artifactIds: artifactIdsSchema,
    content: v.pipe(v.string(), v.maxLength(100_000)),
    idempotencyKey: idempotencyKeySchema,
    images: v.pipe(v.unknown(), v.transform(decodePromptImagesValue)),
    resources: v.pipe(v.unknown(), v.transform(decodePromptResourcesValue)),
};
const messageSchema = v.strictObject(messageEntries);
const turnSchema = v.union([
    v.strictObject({
        messageId: v.pipe(
            nonemptyStringSchema,
            v.transform((value) => validateIdentifier(value, "message_id")),
        ),
    }),
    v.pipe(
        v.strictObject({
            ...messageEntries,
            additionalDirectoryIds: directoryIdsSchema,
            disposition: v.optional(v.literal(SessionPromptDisposition.Reject), SessionPromptDisposition.Reject),
            images: v.unknown(),
            resources: v.unknown(),
            targetCommandId: v.optional(v.literal(""), ""),
        }),
        v.transform((value) => ({
            ...value,
            images: decodePromptImagesValue(value.images),
            resources: decodePromptResourcesValue(value.resources),
        })),
    ),
]);
const cancelTurnSchema = v.strictObject({ idempotencyKey: idempotencyKeySchema });
const interactionResponseSchema = v.variant("kind", [
    v.strictObject({
        kind: v.literal("permission"),
        optionId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
        outcome: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
    }),
    v.strictObject({
        kind: v.literal("elicitation"),
        action: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
        content: v.pipe(v.string(), v.minLength(1), v.maxLength(100_000)),
    }),
]);

function cursor(value: unknown) {
    if (value === undefined) {
        return null;
    }
    if (typeof value !== "string" || value.length > 256) {
        throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid");
    }
    return value;
}

function pageLimit(value: unknown): number {
    if (value === undefined) {
        return DEFAULT_PAGE_SIZE;
    }
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new SessionRuntimeError("invalid_page_size", "The page size is invalid");
    }
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > MAXIMUM_PAGE_SIZE) {
        throw new SessionRuntimeError("invalid_page_size", "The page size is invalid");
    }
    return result;
}

async function authorize(
    bindings: ConversationHttpBindings,
    request: Request,
    permission: ConversationPermission,
    signal: AbortSignal,
) {
    return await bindings.access.authorize(bearer(request), permission, signal);
}

export function createBrowserSessionRoutes() {
    return new Hono<ConversationHttpEnvironment>({ strict: false })
        .get("/v1/client/session", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.Read, context.var.signal);
            return context.json({
                access: {
                    actorRef: access.actorReference,
                    conversationId: access.conversationId,
                    credentialId: access.credentialId,
                    expiresAt: new Date(access.lifetime.expiresAtEpochMilliseconds).toISOString(),
                    permissions: [...access.permissions].map((permission) => permission.value).sort(),
                },
                session: await context.env.sessions.readConversationSession(access, context.var.signal),
            });
        })
        .get("/v1/client/session/configuration", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.Read, context.var.signal);
            return context.json(await context.env.sessions.readConversationConfiguration(access, context.var.signal));
        })
        .post("/v1/client/session/configuration", bodyParser(configurationSchema), async (context) => {
            const value = context.req.valid("json");
            const access = await authorize(context.env, context.req.raw, Permission.Configure, context.var.signal);
            return context.json(
                await context.env.sessions.configureConversation(
                    access,
                    value.idempotencyKey,
                    value.additionalDirectoryIds,
                    value.configId,
                    value.value,
                    value.booleanValue,
                    value.valueType,
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
                202,
            );
        })
        .get("/v1/client/session/messages", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.Read, context.var.signal);
            return context.json(
                await context.env.sessions.readConversationMessages(
                    access,
                    cursor(context.req.query("cursor")),
                    pageLimit(context.req.query("limit")),
                    context.var.signal,
                ),
            );
        })
        .post("/v1/client/session/messages", bodyParser(messageSchema), async (context) => {
            const value = context.req.valid("json");
            const access = await authorize(context.env, context.req.raw, Permission.MessageCreate, context.var.signal);
            return context.json(
                await context.env.access.createMessage(
                    access,
                    value.idempotencyKey,
                    value.content,
                    value.images,
                    value.resources,
                    value.artifactIds,
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
                201,
            );
        })
        .get("/v1/client/session/history", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.Read, context.var.signal);
            const limit = pageLimit(context.req.query("limit"));
            const acceptedMessages = await context.env.access.listMessages(
                access,
                context.req.query("cursor") ?? "",
                limit,
                context.var.signal,
            );
            const turns = await context.env.sessions.readConversationMessages(access, null, limit, context.var.signal);
            return context.json({
                ...acceptedMessages,
                lastCommittedSeq: turns.lastCommittedSeq,
                turns: turns.messages,
            });
        })
        .get("/v1/client/session/events", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.EventRead, context.var.signal);
            const after = context.req.query("after") ?? context.req.query("cursor") ?? "";
            if (context.req.header("accept")?.includes("text/event-stream") === true) {
                const lease = context.env.streams.open(
                    access,
                    bearer(context.req.raw),
                    context.env.access,
                    context.var.signal,
                );
                try {
                    return lease.wrap(
                        await context.env.sessions.openConversationEventStream(access, after, lease.signal),
                    );
                } catch (cause) {
                    lease.fail();
                    throw cause;
                }
            }
            return context.json(
                await context.env.sessions.readConversationEvents(
                    access,
                    cursor(after.length === 0 ? undefined : after),
                    pageLimit(context.req.query("limit")),
                    context.var.signal,
                ),
            );
        })
        .get("/v1/client/session/turns/:turnId", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.Read, context.var.signal);
            return context.json(
                await context.env.sessions.readConversationTurn(
                    access,
                    validateIdentifier(context.req.param("turnId"), "turn_id"),
                    context.var.signal,
                ),
            );
        })
        .post("/v1/client/session/turns", bodyParser(turnSchema), async (context) => {
            const value = context.req.valid("json");
            const access = await authorize(context.env, context.req.raw, Permission.TurnCreate, context.var.signal);
            if ("messageId" in value) {
                const message = await context.env.access.readMessage(access, value.messageId, context.var.signal);
                const accepted = await context.env.bots.runConversationAccessMessage(
                    access,
                    message.messageId,
                    message.content,
                    [],
                    message.images,
                    message.resources,
                    message.artifactIds,
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                );
                const turn = await context.env.sessions.readConversationTurn(
                    access,
                    accepted.turnId,
                    context.var.signal,
                );
                return context.json({ ...accepted, turn }, 202);
            }
            const accepted = await context.env.bots.submitConversationAccessMessage(
                access,
                value.idempotencyKey,
                value.content,
                value.additionalDirectoryIds,
                value.images,
                value.resources,
                value.artifactIds,
                context.env.nowEpochMilliseconds(),
                context.var.signal,
            );
            const turn = await context.env.sessions.readConversationTurn(access, accepted.turnId, context.var.signal);
            return context.json({ ...accepted, turn }, 202);
        })
        .post("/v1/client/session/turns/:turnId/cancel", bodyParser(cancelTurnSchema), async (context) => {
            const value = context.req.valid("json");
            const access = await authorize(context.env, context.req.raw, Permission.TurnCancel, context.var.signal);
            return context.json(
                await context.env.sessions.cancelConversationTurn(
                    access,
                    validateIdentifier(context.req.param("turnId"), "turn_id"),
                    value.idempotencyKey,
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
                202,
            );
        })
        .post("/v1/client/session/turns/:turnId/promote", bodyParser(emptyBodySchema), async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.TurnCreate, context.var.signal);
            return context.json(
                await context.env.sessions.promoteConversationTurnToSteering(
                    access,
                    validateIdentifier(context.req.param("turnId"), "turn_id"),
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
            );
        })
        .get("/v1/client/session/interactions", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.Read, context.var.signal);
            return context.json({
                interactions: await context.env.sessions.readConversationInteractions(access, context.var.signal),
            });
        })
        .get("/v1/client/session/interactions/:interactionId", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.Read, context.var.signal);
            return context.json(
                await context.env.sessions.readConversationInteraction(
                    access,
                    validateIdentifier(context.req.param("interactionId"), "interaction_id"),
                    context.var.signal,
                ),
            );
        })
        .post(
            "/v1/client/session/interactions/:interactionId/response",
            bodyParser(interactionResponseSchema),
            async (context) => {
                const value = context.req.valid("json");
                const access = await authorize(
                    context.env,
                    context.req.raw,
                    Permission.InteractionRespond,
                    context.var.signal,
                );
                const interactionId = validateIdentifier(context.req.param("interactionId"), "interaction_id");
                if (value.kind === "permission") {
                    return context.json(
                        await context.env.sessions.respondToConversationPermission(
                            access,
                            interactionId,
                            value.optionId,
                            value.outcome,
                            context.env.nowEpochMilliseconds(),
                            context.var.signal,
                        ),
                        202,
                    );
                }
                if (value.kind === "elicitation") {
                    return context.json(
                        await context.env.sessions.respondToConversationElicitation(
                            access,
                            interactionId,
                            value.action,
                            value.content,
                            context.env.nowEpochMilliseconds(),
                            context.var.signal,
                        ),
                        202,
                    );
                }
                return value satisfies never;
            },
        );
}
