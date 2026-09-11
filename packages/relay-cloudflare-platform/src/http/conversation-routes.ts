import {
    decodePromptImagesValue,
    decodePromptResourcesValue,
    MOBIUS_API_PREFIX,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import {
    type BotService,
    ConversationAccessError,
    type ConversationPermission,
    CreateArtifactUploadRequest,
    PairingDirectoryError,
    ConversationPermission as Permission,
    ProjectAuthenticationError,
    type RelayContext,
    RequestBodyError,
    readBoundedBytesBody,
    SessionRuntimeError,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { ConversationAccessService } from "../service/conversation-access-service.ts";
import type { ConversationStreamRegistry } from "../service/conversation-stream-service.ts";

const MAXIMUM_BODY_BYTES = 128 * 1_024;
const OPERATION_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 500;
const FORBIDDEN_BROWSER_TARGET_PARAMETERS = Object.freeze([
    "botId",
    "conversationId",
    "projectId",
    "runtimeId",
    "sessionId",
]);
const BROWSER_CORS_HEADERS = new Set(["authorization", "content-type", "x-mobius-upload-token"]);
const BROWSER_CORS_METHODS = new Set(["GET", "POST", "PUT"]);

interface ConversationHttpBindings {
    readonly access: ConversationAccessService;
    readonly allowedOrigins: ReadonlySet<string>;
    readonly bots: BotService;
    readonly nowEpochMilliseconds: () => number;
    readonly sessions: RelayContext["services"]["sessions"];
    readonly streams: ConversationStreamRegistry;
}

function browserCorsHeaders(origin: string): Headers {
    return new Headers({
        "access-control-allow-headers": "authorization, content-type, x-mobius-upload-token",
        "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
        "access-control-allow-origin": origin,
        "access-control-expose-headers": "content-length, content-type, x-mobius-artifact-id, x-mobius-sha256",
        "access-control-max-age": "600",
        vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    });
}

function applyBrowserCors(response: Response, origin: string): void {
    const headers = browserCorsHeaders(origin);
    for (const [name, value] of headers) {
        response.headers.set(name, value);
    }
}

interface ConversationHttpEnvironment {
    readonly Bindings: ConversationHttpBindings;
    readonly Variables: { readonly signal: AbortSignal };
}

function errorResponse(error: unknown): Response {
    if (error instanceof PlatformControlPlaneError) {
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    if (error instanceof ConversationAccessError) {
        const status = error.code === "conversation_permission_denied" ? 403 : 401;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    if (error instanceof ProjectAuthenticationError) {
        const status = error.code === "project_permission_denied" || error.code === "project_access_denied" ? 403 : 401;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    if (error instanceof PairingDirectoryError) {
        const status =
            error.code === "runtime_access_denied"
                ? 403
                : error.code === "runtime_unavailable" || error.code === "idempotency_conflict"
                  ? 409
                  : error.code === "unauthorized"
                    ? 401
                    : 400;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    if (error instanceof SessionRuntimeError) {
        const status =
            error.code === "session_not_found" ||
            error.code === "artifact_not_found" ||
            error.code === "interaction_not_found" ||
            error.code === "pending_work_not_found"
                ? 404
                : error.code === "session_access_denied" || error.code === "artifact_upload_unauthorized"
                  ? 403
                  : error.code === "session_deleted" ||
                      error.code === "cursor_expired" ||
                      error.code === "artifact_upload_expired"
                    ? 410
                    : error.code === "session_busy" ||
                        error.code === "session_conflict" ||
                        error.code === "idempotency_conflict" ||
                        error.code === "interaction_conflict" ||
                        error.code === "artifact_upload_closed" ||
                        error.code === "artifact_not_ready"
                      ? 409
                      : error.code === "content_too_large"
                        ? 413
                        : error.code === "invalid_cursor" ||
                            error.code === "invalid_page_size" ||
                            error.code === "invalid_request" ||
                            error.code === "artifact_content_mismatch"
                          ? 400
                          : 503;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    console.error("Platform Conversation request failed", error);
    return Response.json(
        { error: { code: "conversation_service_unavailable", message: "The Conversation service is unavailable" } },
        { status: 503 },
    );
}

async function body(request: Request, allowedKeys: readonly string[]): Promise<Readonly<Record<string, unknown>>> {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "application/json") {
        throw new PlatformControlPlaneError("invalid_request", "A JSON request body is required", 400);
    }
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAXIMUM_BODY_BYTES) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is too large", 413);
    }
    const encoded = await request.text();
    if (new TextEncoder().encode(encoded).byteLength > MAXIMUM_BODY_BYTES) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is too large", 413);
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is invalid", 400, { cause });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is invalid", 400);
    }
    const result = Object.freeze(Object.fromEntries(Object.entries(value)));
    if (Object.keys(result).some((key) => !allowedKeys.includes(key))) {
        throw new PlatformControlPlaneError("invalid_request", "The request body contains an unsupported field", 400);
    }
    return result;
}

function string(value: Readonly<Record<string, unknown>>, key: string, maximum = 128, allowEmpty = false): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximum || (!allowEmpty && field.length === 0)) {
        throw new PlatformControlPlaneError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function integer(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new PlatformControlPlaneError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function boolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
    const field = value[key];
    if (typeof field !== "boolean") {
        throw new PlatformControlPlaneError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function stringArray(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength: number,
    identifierName: string,
): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.length > maximumLength || field.some((entry) => typeof entry !== "string")) {
        throw new PlatformControlPlaneError("invalid_request", `The ${key} field is invalid`, 400);
    }
    const result = field
        .filter((entry) => typeof entry === "string")
        .map((entry) => validateIdentifier(entry, identifierName));
    if (new Set(result).size !== result.length) {
        throw new PlatformControlPlaneError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return Object.freeze(result);
}

function bearer(request: Request): string {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
        throw new ConversationAccessError("conversation_credential_required", "A Conversation credential is required");
    }
    const credential = authorization.slice("Bearer ".length);
    if (credential.length === 0 || credential.length > 16 * 1_024) {
        throw new ConversationAccessError("conversation_credential_required", "A Conversation credential is required");
    }
    return credential;
}

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

function sha256(value: Readonly<Record<string, unknown>>): string {
    const digest = string(value, "sha256", 64);
    if (!/^[a-f0-9]{64}$/.test(digest)) {
        throw new PlatformControlPlaneError("invalid_request", "The sha256 field is invalid", 400);
    }
    return digest;
}

function disposition(value: Readonly<Record<string, unknown>>): string {
    const requested = value["disposition"];
    if (requested === undefined) {
        return SessionPromptDisposition.Reject;
    }
    if (
        requested !== SessionPromptDisposition.Reject &&
        requested !== SessionPromptDisposition.Queue &&
        requested !== SessionPromptDisposition.Steer
    ) {
        throw new PlatformControlPlaneError("invalid_request", "The disposition field is invalid", 400);
    }
    return requested;
}

function targetCommandId(value: Readonly<Record<string, unknown>>, requestedDisposition: string): string {
    const field = value["targetCommandId"];
    const requested = field === undefined ? "" : string(value, "targetCommandId", 128, true);
    const normalized = requested.length === 0 ? "" : validateIdentifier(requested, "target_command_id");
    if (
        (requestedDisposition === SessionPromptDisposition.Reject && normalized.length > 0) ||
        (requestedDisposition !== SessionPromptDisposition.Reject && normalized.length === 0)
    ) {
        throw new PlatformControlPlaneError("invalid_request", "The targetCommandId field is invalid", 400);
    }
    return normalized;
}

async function authorize(
    bindings: ConversationHttpBindings,
    request: Request,
    permission: ConversationPermission,
    signal: AbortSignal,
) {
    return await bindings.access.authorize(bearer(request), permission, signal);
}

export function createConversationApplication() {
    return new Hono<ConversationHttpEnvironment>({ strict: false })
        .basePath(MOBIUS_API_PREFIX)
        .use("*", async (context, next) => {
            const browserPath = context.req.path.startsWith(`${MOBIUS_API_PREFIX}/v1/client/session`);
            if (browserPath) {
                const parameters = new URL(context.req.raw.url).searchParams;
                if (FORBIDDEN_BROWSER_TARGET_PARAMETERS.some((name) => parameters.has(name))) {
                    throw new PlatformControlPlaneError(
                        "browser_target_not_allowed",
                        "Browser Session routes do not accept resource target identifiers",
                        400,
                    );
                }
                const origin = context.req.header("origin") ?? "";
                if (origin.length > 0 && !context.env.allowedOrigins.has(origin)) {
                    throw new PlatformControlPlaneError(
                        "browser_origin_denied",
                        "The browser origin is not allowed",
                        403,
                    );
                }
                if (context.req.method === "OPTIONS") {
                    if (origin.length === 0) {
                        throw new PlatformControlPlaneError(
                            "browser_origin_denied",
                            "The browser origin is not allowed",
                            403,
                        );
                    }
                    const requestedMethod = context.req.header("access-control-request-method") ?? "";
                    const requestedHeaders = (context.req.header("access-control-request-headers") ?? "")
                        .split(",")
                        .map((header) => header.trim().toLowerCase())
                        .filter((header) => header.length > 0);
                    if (
                        !BROWSER_CORS_METHODS.has(requestedMethod) ||
                        requestedHeaders.some((header) => !BROWSER_CORS_HEADERS.has(header))
                    ) {
                        throw new PlatformControlPlaneError(
                            "browser_preflight_denied",
                            "The browser preflight request is not allowed",
                            403,
                        );
                    }
                    return new Response(null, { headers: browserCorsHeaders(origin), status: 204 });
                }
            }
            const stream =
                context.req.path === `${MOBIUS_API_PREFIX}/v1/client/session/events` &&
                context.req.header("accept")?.includes("text/event-stream") === true;
            context.set(
                "signal",
                stream
                    ? context.req.raw.signal
                    : AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MILLISECONDS)]),
            );
            await next();
            const origin = context.req.header("origin") ?? "";
            if (browserPath && origin.length > 0) {
                applyBrowserCors(context.res, origin);
            }
            return context.res;
        })
        .onError((error) => errorResponse(error))
        .post("/v1/platform/projects/:projectId/conversation-access-credentials", async (context) => {
            const value = await body(context.req.raw, [
                "actorRef",
                "conversationId",
                "expiresInSeconds",
                "permissions",
                "sessionId",
            ]);
            return context.json(
                await context.env.access.issue(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    bearer(context.req.raw),
                    validateIdentifier(string(value, "conversationId"), "conversation_id"),
                    validateIdentifier(string(value, "sessionId"), "session_id"),
                    string(value, "actorRef", 200),
                    value["permissions"],
                    integer(value, "expiresInSeconds"),
                    context.var.signal,
                ),
                201,
            );
        })
        .post("/v1/conversations/:conversationId/access-credentials", async (context) => {
            const value = await body(context.req.raw, ["actorRef", "expiresInSeconds", "permissions"]);
            return context.json(
                await context.env.access.issueForConversation(
                    validateIdentifier(context.req.param("conversationId"), "conversation_id"),
                    bearer(context.req.raw),
                    string(value, "actorRef", 200),
                    value["permissions"],
                    integer(value, "expiresInSeconds"),
                    context.var.signal,
                ),
                201,
            );
        })
        .post("/v1/platform/conversation-access-credentials/:credentialId/rotate", async (context) => {
            const value = await body(context.req.raw, ["expiresInSeconds"]);
            const credentialId = validateIdentifier(context.req.param("credentialId"), "credential_id");
            const replacement = await context.env.access.rotate(
                credentialId,
                bearer(context.req.raw),
                integer(value, "expiresInSeconds"),
                context.var.signal,
            );
            context.env.streams.revoke(credentialId);
            return context.json(replacement, 201);
        })
        .post("/v1/platform/conversation-access-credentials/:credentialId/revoke", async (context) => {
            await body(context.req.raw, []);
            const credentialId = validateIdentifier(context.req.param("credentialId"), "credential_id");
            const revocation = await context.env.access.revoke(
                credentialId,
                bearer(context.req.raw),
                context.var.signal,
            );
            context.env.streams.revoke(credentialId);
            return context.json(revocation);
        })
        .post("/v1/conversation-access-credentials/:credentialId/rotate", async (context) => {
            const value = await body(context.req.raw, ["expiresInSeconds"]);
            const credentialId = validateIdentifier(context.req.param("credentialId"), "credential_id");
            const replacement = await context.env.access.rotate(
                credentialId,
                bearer(context.req.raw),
                integer(value, "expiresInSeconds"),
                context.var.signal,
            );
            context.env.streams.revoke(credentialId);
            return context.json(replacement, 201);
        })
        .post("/v1/conversation-access-credentials/:credentialId/revoke", async (context) => {
            await body(context.req.raw, []);
            const credentialId = validateIdentifier(context.req.param("credentialId"), "credential_id");
            const revocation = await context.env.access.revoke(
                credentialId,
                bearer(context.req.raw),
                context.var.signal,
            );
            context.env.streams.revoke(credentialId);
            return context.json(revocation);
        })
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
        .post("/v1/client/session/configuration", async (context) => {
            const value = await body(context.req.raw, [
                "additionalDirectoryIds",
                "booleanValue",
                "configId",
                "idempotencyKey",
                "value",
                "valueType",
            ]);
            const access = await authorize(context.env, context.req.raw, Permission.Configure, context.var.signal);
            return context.json(
                await context.env.sessions.configureConversation(
                    access,
                    validateIdentifier(string(value, "idempotencyKey"), "idempotency_key"),
                    stringArray(value, "additionalDirectoryIds", 16, "directory_id"),
                    string(value, "configId"),
                    string(value, "value", 500, true),
                    boolean(value, "booleanValue"),
                    string(value, "valueType", 32),
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
        .post("/v1/client/session/messages", async (context) => {
            const value = await body(context.req.raw, [
                "artifactIds",
                "content",
                "idempotencyKey",
                "images",
                "resources",
            ]);
            const access = await authorize(context.env, context.req.raw, Permission.MessageCreate, context.var.signal);
            return context.json(
                await context.env.access.createMessage(
                    access,
                    validateIdentifier(string(value, "idempotencyKey"), "idempotency_key"),
                    string(value, "content", 100_000, true),
                    decodePromptImagesValue(value["images"]),
                    decodePromptResourcesValue(value["resources"]),
                    stringArray(value, "artifactIds", 16, "artifact_id"),
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
        .post("/v1/client/session/turns", async (context) => {
            const value = await body(context.req.raw, [
                "additionalDirectoryIds",
                "artifactIds",
                "content",
                "disposition",
                "idempotencyKey",
                "images",
                "messageId",
                "resources",
                "targetCommandId",
            ]);
            const access = await authorize(context.env, context.req.raw, Permission.TurnCreate, context.var.signal);
            if (value["messageId"] !== undefined) {
                if (Object.keys(value).length !== 1) {
                    throw new PlatformControlPlaneError(
                        "invalid_request",
                        "A stored message Turn cannot include inline prompt fields",
                        400,
                    );
                }
                const message = await context.env.access.readMessage(
                    access,
                    validateIdentifier(string(value, "messageId"), "message_id"),
                    context.var.signal,
                );
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
            const requestedDisposition = disposition(value);
            if (requestedDisposition !== SessionPromptDisposition.Reject) {
                throw new PlatformControlPlaneError(
                    "invalid_request",
                    "Platform Conversation turns do not support queue or steering targets",
                    400,
                );
            }
            targetCommandId(value, requestedDisposition);
            const accepted = await context.env.bots.submitConversationAccessMessage(
                access,
                validateIdentifier(string(value, "idempotencyKey"), "idempotency_key"),
                string(value, "content", 100_000, true),
                stringArray(value, "additionalDirectoryIds", 16, "directory_id"),
                decodePromptImagesValue(value["images"]),
                decodePromptResourcesValue(value["resources"]),
                stringArray(value, "artifactIds", 16, "artifact_id"),
                context.env.nowEpochMilliseconds(),
                context.var.signal,
            );
            const turn = await context.env.sessions.readConversationTurn(access, accepted.turnId, context.var.signal);
            return context.json({ ...accepted, turn }, 202);
        })
        .post("/v1/client/session/turns/:turnId/cancel", async (context) => {
            const value = await body(context.req.raw, ["idempotencyKey"]);
            const access = await authorize(context.env, context.req.raw, Permission.TurnCancel, context.var.signal);
            return context.json(
                await context.env.sessions.cancelConversationTurn(
                    access,
                    validateIdentifier(context.req.param("turnId"), "turn_id"),
                    validateIdentifier(string(value, "idempotencyKey"), "idempotency_key"),
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
                202,
            );
        })
        .post("/v1/client/session/turns/:turnId/promote", async (context) => {
            await body(context.req.raw, []);
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
        .post("/v1/client/session/interactions/:interactionId/respond", async (context) => {
            const value = await body(context.req.raw, ["action", "content", "kind", "optionId", "outcome"]);
            const access = await authorize(
                context.env,
                context.req.raw,
                Permission.InteractionRespond,
                context.var.signal,
            );
            const interactionId = validateIdentifier(context.req.param("interactionId"), "interaction_id");
            const kind = string(value, "kind", 32);
            if (kind === "permission") {
                if (value["action"] !== undefined || value["content"] !== undefined) {
                    throw new PlatformControlPlaneError("invalid_request", "The Interaction response is invalid", 400);
                }
                return context.json(
                    await context.env.sessions.respondToConversationPermission(
                        access,
                        interactionId,
                        string(value, "optionId", 255),
                        string(value, "outcome", 32),
                        context.env.nowEpochMilliseconds(),
                        context.var.signal,
                    ),
                    202,
                );
            }
            if (kind === "elicitation") {
                if (value["optionId"] !== undefined || value["outcome"] !== undefined) {
                    throw new PlatformControlPlaneError("invalid_request", "The Interaction response is invalid", 400);
                }
                return context.json(
                    await context.env.sessions.respondToConversationElicitation(
                        access,
                        interactionId,
                        string(value, "action", 32),
                        string(value, "content", 100_000),
                        context.env.nowEpochMilliseconds(),
                        context.var.signal,
                    ),
                    202,
                );
            }
            throw new PlatformControlPlaneError("invalid_request", "The Interaction response kind is invalid", 400);
        })
        .post("/v1/client/session/interactions/:interactionId/response", async (context) => {
            const value = await body(context.req.raw, ["action", "content", "kind", "optionId", "outcome"]);
            const access = await authorize(
                context.env,
                context.req.raw,
                Permission.InteractionRespond,
                context.var.signal,
            );
            const interactionId = validateIdentifier(context.req.param("interactionId"), "interaction_id");
            const kind = string(value, "kind", 32);
            if (kind === "permission") {
                if (value["action"] !== undefined || value["content"] !== undefined) {
                    throw new PlatformControlPlaneError("invalid_request", "The Interaction response is invalid", 400);
                }
                return context.json(
                    await context.env.sessions.respondToConversationPermission(
                        access,
                        interactionId,
                        string(value, "optionId", 255),
                        string(value, "outcome", 32),
                        context.env.nowEpochMilliseconds(),
                        context.var.signal,
                    ),
                    202,
                );
            }
            if (kind === "elicitation") {
                if (value["optionId"] !== undefined || value["outcome"] !== undefined) {
                    throw new PlatformControlPlaneError("invalid_request", "The Interaction response is invalid", 400);
                }
                return context.json(
                    await context.env.sessions.respondToConversationElicitation(
                        access,
                        interactionId,
                        string(value, "action", 32),
                        string(value, "content", 100_000),
                        context.env.nowEpochMilliseconds(),
                        context.var.signal,
                    ),
                    202,
                );
            }
            throw new PlatformControlPlaneError("invalid_request", "The Interaction response kind is invalid", 400);
        })
        .post("/v1/client/session/artifacts/uploads", async (context) => {
            const value = await body(context.req.raw, ["byteLength", "mediaType", "name", "sha256"]);
            const access = await authorize(context.env, context.req.raw, Permission.ArtifactWrite, context.var.signal);
            return context.json(
                await context.env.sessions.createConversationArtifactUpload(
                    access,
                    new CreateArtifactUploadRequest(
                        string(value, "name", 500),
                        string(value, "mediaType", 255),
                        integer(value, "byteLength"),
                        sha256(value),
                    ),
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
                201,
            );
        })
        .post("/v1/client/session/artifacts", async (context) => {
            const value = await body(context.req.raw, ["byteLength", "mediaType", "name", "sha256"]);
            const access = await authorize(context.env, context.req.raw, Permission.ArtifactWrite, context.var.signal);
            return context.json(
                await context.env.sessions.createConversationArtifactUpload(
                    access,
                    new CreateArtifactUploadRequest(
                        string(value, "name", 500),
                        string(value, "mediaType", 255),
                        integer(value, "byteLength"),
                        sha256(value),
                    ),
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
                201,
            );
        })
        .put("/v1/client/session/artifacts/:artifactId/content", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.ArtifactWrite, context.var.signal);
            const lease = await context.env.sessions.authorizeConversationArtifactUpload(
                access,
                validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                context.req.header("x-mobius-upload-token") ?? "",
                context.env.nowEpochMilliseconds(),
                context.var.signal,
            );
            if (context.req.header("content-type") !== lease.artifact.mediaType) {
                throw new SessionRuntimeError(
                    "artifact_content_mismatch",
                    "The artifact media type does not match its authorization",
                );
            }
            let bytes: Uint8Array;
            try {
                bytes = await readBoundedBytesBody(context.req.raw, lease.artifact.byteLength);
            } catch (cause) {
                if (cause instanceof RequestBodyError) {
                    throw new SessionRuntimeError(
                        "artifact_content_mismatch",
                        "The artifact body does not match its authorization",
                        { cause },
                    );
                }
                throw cause;
            }
            return context.json(
                await context.env.sessions.completeConversationArtifactUpload(
                    access,
                    lease,
                    bytes,
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
            );
        })
        .get("/v1/client/session/artifacts/:artifactId", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.ArtifactRead, context.var.signal);
            return context.json(
                await context.env.sessions.readConversationArtifact(
                    access,
                    validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
            );
        })
        .get("/v1/client/session/artifacts/:artifactId/content", async (context) => {
            const access = await authorize(context.env, context.req.raw, Permission.ArtifactRead, context.var.signal);
            const content = await context.env.sessions.readConversationArtifactContent(
                access,
                validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                context.var.signal,
            );
            return new Response(Uint8Array.from(content.bytes), {
                headers: {
                    "content-length": content.bytes.byteLength.toString(),
                    "content-type": content.artifact.mediaType,
                    "x-mobius-artifact-id": content.artifact.artifactId,
                    "x-mobius-sha256": content.artifact.sha256,
                },
            });
        });
}
