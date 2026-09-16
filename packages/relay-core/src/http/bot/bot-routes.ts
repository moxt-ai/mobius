import { decodePromptImagesValue, decodePromptResourcesValue, MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";
import type { OperationTiming } from "../../infra/operation-timing.ts";
import type { BotService } from "../../service/bot/bot-service.ts";
import { botBodyParser } from "../middleware/bot-body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import { operationTimingMiddleware } from "../middleware/operation-timing-middleware.ts";
import { requestTimeoutMiddleware } from "../middleware/request-timeout-middleware.ts";
import {
    actorReference,
    bearer,
    boolean,
    completionPolicy,
    connectorScopes,
    conversationConfiguration,
    conversationRequest,
    cursor,
    directoryIdentifier,
    exactBody,
    executionCapability,
    identifier,
    identifiers,
    integer,
    messageCursor,
    messagePageLimit,
    messageRequest,
    object,
    pageLimit,
    pathIdentifier,
    positiveInteger,
    string,
} from "./bot-input.ts";

interface BotHttpEnvironment {
    readonly Bindings: {
        readonly services: {
            readonly bots: BotService;
        };
    };
    readonly Variables: {
        readonly bots: BotService;
        readonly body: Readonly<Record<string, unknown>>;
        readonly operationTiming: OperationTiming;
        readonly signal: AbortSignal;
    };
}

export function createBotApplication() {
    return new Hono<BotHttpEnvironment>({ strict: false })
        .basePath(`${MOBIUS_API_PREFIX}/v1`)
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .use("*", requestTimeoutMiddleware<BotHttpEnvironment>(15_000))
        .use("/projects/:projectId/conversations", operationTimingMiddleware<BotHttpEnvironment>())
        .use(
            "/projects/:projectId/conversations/:conversationId/configuration-revisions",
            operationTimingMiddleware<BotHttpEnvironment>(),
        )
        .use("*", async (c, next) => {
            c.set("bots", c.env.services.bots);
            await next();
        })
        .use("/projects/:projectId/*", async (c, next) => {
            c.set("bots", c.env.services.bots.forProject(pathIdentifier(c.req.param("projectId"))));
            await next();
        })
        .get("/projects/:projectId/bots", async (c) =>
            c.json(
                await c.var.bots.listOwnedBots(
                    pathIdentifier(c.req.param("projectId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .post("/projects/:projectId/bots", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["avatarRef", "description", "displayName"]);
            return c.json(
                await c.var.bots.createBot(
                    pathIdentifier(c.req.param("projectId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    string(value, "displayName", 80),
                    string(value, "avatarRef", 4096, true),
                    string(value, "description", 2000, true),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/projects/:projectId/conversations", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, [
                "botId",
                "clientReference",
                "configuration",
                "idempotencyKey",
                "title",
            ]);
            const configuration = conversationConfiguration(value);
            const conversation = await c.var.bots.createProjectConversationResource(
                pathIdentifier(c.req.param("projectId")),
                identifier(value, "botId"),
                bearer(c.req.raw),
                actorReference(c.req.raw),
                identifier(value, "clientReference"),
                identifier(value, "idempotencyKey"),
                string(value, "title", 500, true),
                Date.now(),
                c.var.signal,
                c.var.operationTiming,
            );
            const conversationId = Reflect.get(conversation, "conversationId");
            if (typeof conversationId !== "string") {
                throw new Error("The created Conversation identifier is unavailable");
            }
            await c.var.bots.configureProjectConversation(
                conversationId,
                bearer(c.req.raw),
                actorReference(c.req.raw),
                identifier(value, "idempotencyKey"),
                configuration.additionalDirectoryIds,
                configuration.configId,
                configuration.value,
                configuration.booleanValue,
                configuration.valueType,
                Date.now(),
                c.var.signal,
                c.var.operationTiming,
            );
            return c.json(conversation, 201);
        })
        .route("/projects/:projectId", createBotOwnerRoutes())
        .route("/projects/:projectId", createBotConversationRoutes())
        .route("/", createBotConnectorRoutes());
}

function createBotOwnerRoutes() {
    return new Hono<BotHttpEnvironment>({ strict: false })
        .get("/bots/:botId", async (c) =>
            c.json(
                await c.var.bots.readBot(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .get("/conversations/:conversationId", async (c) =>
            c.json(
                await c.var.bots.readProjectConversationResource(
                    pathIdentifier(c.req.param("conversationId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .post("/conversations/:conversationId/turns", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, [
                "additionalDirectoryIds",
                "artifactIds",
                "content",
                "idempotencyKey",
                "images",
                "resources",
            ]);
            return c.json(
                await c.var.bots.submitProjectConversationTurn(
                    pathIdentifier(c.req.param("conversationId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    identifier(value, "idempotencyKey"),
                    string(value, "content", 100_000, true),
                    identifiers(value, "additionalDirectoryIds", 16),
                    decodePromptImagesValue(value["images"]),
                    decodePromptResourcesValue(value["resources"]),
                    identifiers(value, "artifactIds", 16),
                    Date.now(),
                    c.var.signal,
                ),
                202,
            );
        })
        .post(
            "/conversations/:conversationId/configuration-revisions",
            botBodyParser<BotHttpEnvironment>(),
            async (c) => {
                const value = exactBody(c.var.body, [
                    "additionalDirectoryIds",
                    "booleanValue",
                    "configId",
                    "idempotencyKey",
                    "value",
                    "valueType",
                ]);
                return c.json(
                    await c.var.bots.configureProjectConversation(
                        pathIdentifier(c.req.param("conversationId")),
                        bearer(c.req.raw),
                        actorReference(c.req.raw),
                        identifier(value, "idempotencyKey"),
                        identifiers(value, "additionalDirectoryIds", 16),
                        identifier(value, "configId"),
                        string(value, "value", 500, true),
                        boolean(value, "booleanValue"),
                        string(value, "valueType", 32),
                        Date.now(),
                        c.var.signal,
                        c.var.operationTiming,
                    ),
                    202,
                );
            },
        )
        .get("/bots/:botId/behavior-revisions", async (c) =>
            c.json(
                await c.var.bots.listBehaviorRevisions(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .get("/bots/:botId/execution-bindings", async (c) =>
            c.json(
                await c.var.bots.listExecutionBindings(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .post("/bots/:botId/agent-configuration", botBodyParser<BotHttpEnvironment>(), async (c) => {
            exactBody(c.var.body, []);
            return c.json({
                options: await c.var.bots.inspectAgentConfiguration(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            });
        })
        .get("/bots/:botId/connections", async (c) =>
            c.json(
                await c.var.bots.listConnections(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .get("/bots/:botId/conversations", async (c) =>
            c.json(
                await c.var.bots.listConversations(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .get("/bots/:botId/setup", async (c) =>
            c.json(
                await c.var.bots.readSetup(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    c.var.signal,
                ),
            ),
        )
        .post("/bots/:botId/profile-revisions", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["avatarRef", "description", "displayName", "expectedRevision"]);
            return c.json(
                await c.var.bots.createProfileRevision(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    string(value, "displayName", 80),
                    string(value, "avatarRef", 4096, true),
                    string(value, "description", 2000, true),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bots/:botId/behavior-revisions", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, [
                "agentConfiguration",
                "expectedRevision",
                "instructions",
                "requiredCapabilities",
            ]);
            return c.json(
                await c.var.bots.createBehaviorRevision(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    string(value, "instructions", 100_000, true),
                    identifiers(value, "requiredCapabilities", 32),
                    object(value, "agentConfiguration"),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bots/:botId/execution-bindings", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, [
                "agentConfigRevision",
                "agentRef",
                "allowedDeliveryTargetIds",
                "behaviorRevisionId",
                "completionPolicy",
                "expectedRevision",
                "runtimeId",
                "workspaceRef",
            ]);
            return c.json(
                await c.var.bots.createExecutionBinding(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    identifier(value, "behaviorRevisionId"),
                    identifier(value, "runtimeId"),
                    identifier(value, "agentRef"),
                    directoryIdentifier(value, "workspaceRef"),
                    positiveInteger(value, "agentConfigRevision"),
                    identifiers(value, "allowedDeliveryTargetIds", 64),
                    completionPolicy(value),
                    Date.now(),
                    c.var.signal,
                ),
                202,
            );
        })
        .post("/bots/:botId/connection-grants", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["audience", "expiresInSeconds", "label", "scopes"]);
            return c.json(
                await c.var.bots.createGrant(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    identifier(value, "audience"),
                    string(value, "label", 200),
                    connectorScopes(value),
                    integer(value, "expiresInSeconds"),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bots/:botId/delivery-targets/:targetId/approve", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["expectedPolicyRevision"]);
            return c.json(
                await c.var.bots.approveTarget(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("targetId")),
                    integer(value, "expectedPolicyRevision"),
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bots/:botId/suspend", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["expectedRevision"]);
            return c.json(
                await c.var.bots.transitionBot(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    "suspend",
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bots/:botId/connections/:connectionId/revoke", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["expectedRevision"]);
            return c.json(
                await c.var.bots.revokeConnectionForOwner(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("connectionId")),
                    integer(value, "expectedRevision"),
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bots/:botId/archive", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["expectedRevision"]);
            return c.json(
                await c.var.bots.transitionBot(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    "archive",
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bots/:botId/resume", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["expectedRevision"]);
            return c.json(
                await c.var.bots.transitionBot(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    integer(value, "expectedRevision"),
                    "resume",
                    Date.now(),
                    c.var.signal,
                ),
            );
        });
}

function createBotConversationRoutes() {
    return new Hono<BotHttpEnvironment>({ strict: false })
        .post("/bots/:botId/conversations", botBodyParser<BotHttpEnvironment>(), async (c) =>
            c.json(
                await c.var.bots.createConversation(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    conversationRequest(c.var.body),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            ),
        )
        .get("/bots/:botId/conversations/:conversationId/messages", async (c) => {
            const url = new URL(c.req.url);
            return c.json(
                await c.var.bots.readConversationMessages(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("conversationId")),
                    messageCursor(url),
                    messagePageLimit(url),
                    c.var.signal,
                ),
            );
        })
        .post("/bots/:botId/conversations/:conversationId/messages", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const submission = messageRequest(c.var.body);
            return c.json(
                await c.var.bots.submitMessage(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("conversationId")),
                    submission,
                    Date.now(),
                    c.var.signal,
                ),
                202,
            );
        })
        .get("/bots/:botId/conversations/:conversationId/events", async (c) =>
            c.json(
                await c.var.bots.readConversationEvents(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("conversationId")),
                    c.req.query("after") ?? "",
                    c.var.signal,
                ),
            ),
        )
        .post("/bots/:botId/turns/:turnId/cancel", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["idempotencyKey"]);
            return c.json(
                await c.var.bots.cancelTurn(
                    pathIdentifier(c.req.param("botId")),
                    bearer(c.req.raw),
                    actorReference(c.req.raw),
                    pathIdentifier(c.req.param("turnId")),
                    identifier(value, "idempotencyKey"),
                    Date.now(),
                    c.var.signal,
                ),
                202,
            );
        });
}

function createBotConnectorRoutes() {
    return new Hono<BotHttpEnvironment>({ strict: false })
        .post("/bot-connection-grants/redeem", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["audience", "connectorPrincipalId", "grantId", "grantSecret"]);
            return c.json(
                await c.env.services.bots.redeemGrant(
                    identifier(value, "grantId"),
                    string(value, "grantSecret", 256),
                    identifier(value, "audience"),
                    string(value, "connectorPrincipalId", 500),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bot-connections/:connectionId/credentials/rotate", botBodyParser<BotHttpEnvironment>(), async (c) => {
            exactBody(c.var.body, []);
            return c.json(
                await c.env.services.bots.rotateCredential(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post("/bot-connections/:connectionId/revoke", botBodyParser<BotHttpEnvironment>(), async (c) => {
            exactBody(c.var.body, []);
            return c.json(
                await c.env.services.bots.revokeConnection(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    Date.now(),
                    c.var.signal,
                ),
            );
        })
        .post("/bot-connections/:connectionId/delivery-targets", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["alias"]);
            return c.json(
                await c.env.services.bots.createTarget(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    identifier(value, "alias"),
                    Date.now(),
                    c.var.signal,
                ),
                201,
            );
        })
        .post(
            "/bot-connections/:connectionId/delivery-targets/:targetId/disable",
            botBodyParser<BotHttpEnvironment>(),
            async (c) => {
                exactBody(c.var.body, []);
                return c.json(
                    await c.env.services.bots.disableTarget(
                        pathIdentifier(c.req.param("connectionId")),
                        bearer(c.req.raw),
                        pathIdentifier(c.req.param("targetId")),
                        Date.now(),
                        c.var.signal,
                    ),
                );
            },
        )
        .get("/bot-connections/:connectionId/outbound-events", async (c) =>
            c.json(
                await c.env.services.bots.readOutbound(
                    pathIdentifier(c.req.param("connectionId")),
                    bearer(c.req.raw),
                    cursor(new URL(c.req.url)),
                    pageLimit(new URL(c.req.url)),
                    Date.now(),
                    c.var.signal,
                ),
            ),
        )
        .post(
            "/bot-connections/:connectionId/outbound-messages/:messageId/delivered",
            botBodyParser<BotHttpEnvironment>(),
            async (c) => {
                const value = exactBody(c.var.body, ["claimId"]);
                return c.json(
                    await c.env.services.bots.delivered(
                        pathIdentifier(c.req.param("connectionId")),
                        bearer(c.req.raw),
                        pathIdentifier(c.req.param("messageId")),
                        identifier(value, "claimId"),
                        Date.now(),
                        c.var.signal,
                    ),
                );
            },
        )
        .post(
            "/bot-connections/:connectionId/outbound-messages/:messageId/retryable-failure",
            botBodyParser<BotHttpEnvironment>(),
            async (c) => {
                const value = exactBody(c.var.body, ["claimId", "code", "retryAfterSeconds"]);
                return c.json(
                    await c.env.services.bots.retryableFailure(
                        pathIdentifier(c.req.param("connectionId")),
                        bearer(c.req.raw),
                        pathIdentifier(c.req.param("messageId")),
                        identifier(value, "claimId"),
                        identifier(value, "code"),
                        integer(value, "retryAfterSeconds"),
                        Date.now(),
                        c.var.signal,
                    ),
                );
            },
        )
        .post(
            "/bot-connections/:connectionId/outbound-messages/:messageId/terminal-failure",
            botBodyParser<BotHttpEnvironment>(),
            async (c) => {
                const value = exactBody(c.var.body, ["claimId", "code"]);
                return c.json(
                    await c.env.services.bots.terminalFailure(
                        pathIdentifier(c.req.param("connectionId")),
                        bearer(c.req.raw),
                        pathIdentifier(c.req.param("messageId")),
                        identifier(value, "claimId"),
                        identifier(value, "code"),
                        Date.now(),
                        c.var.signal,
                    ),
                );
            },
        )
        .post("/bot-executions/:executionId/reply-messages", botBodyParser<BotHttpEnvironment>(), async (c) => {
            const value = exactBody(c.var.body, ["idempotencyKey", "text"]);
            return c.json(
                await c.env.services.bots.acceptOutbound(
                    pathIdentifier(c.req.param("executionId")),
                    bearer(c.req.raw),
                    executionCapability(c.req.raw),
                    { kind: "reply" },
                    { idempotencyKey: identifier(value, "idempotencyKey"), text: string(value, "text", 10_000) },
                    Date.now(),
                    c.var.signal,
                ),
                202,
            );
        })
        .post(
            "/bot-executions/:executionId/delivery-targets/:targetId/messages",
            botBodyParser<BotHttpEnvironment>(),
            async (c) => {
                const value = exactBody(c.var.body, ["idempotencyKey", "text"]);
                return c.json(
                    await c.env.services.bots.acceptOutbound(
                        pathIdentifier(c.req.param("executionId")),
                        bearer(c.req.raw),
                        executionCapability(c.req.raw),
                        { kind: "target", id: pathIdentifier(c.req.param("targetId")) },
                        { idempotencyKey: identifier(value, "idempotencyKey"), text: string(value, "text", 10_000) },
                        Date.now(),
                        c.var.signal,
                    ),
                    202,
                );
            },
        );
}
