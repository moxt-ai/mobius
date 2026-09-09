import {
    AGENT_MESSAGE_DELTA_KIND,
    type BotCompletionDeliveryPolicy,
    BotConnectionReplyRoute,
    MOBIUS_API_PREFIX,
    NoBotCompletionDeliveryPolicy,
    RequiredBotCompletionDeliveryPolicy,
    SESSION_COMPLETED_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_FAILED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
} from "@moxt-ai/mobius-protocol";
import {
    BotConversationEvent,
    BotConversationEventPage,
    BotOutboundSubmission,
    BotTurnSubmission,
    type ChannelGateway,
    RequestBodyError,
    readBoundedUtf8Body,
} from "@moxt-ai/mobius-relay-core";

import { BotApiError, botErrorResponse } from "./bot-api-error.ts";
import { CloudflareBotConnectionRuntime } from "./cloudflare-bot-connection-runtime.ts";
import { CloudflareBotSessionRuntime } from "./cloudflare-bot-session-runtime.ts";
import type { CloudflareSessionRuntime } from "./cloudflare-session-runtime.ts";
import type { BotRuntimeExecutionAccess } from "./d1-bot-auth.ts";
import { D1BotAuthorization, InboundBotConnectorPrincipal, InboundBotOwnerPrincipal } from "./d1-bot-auth.ts";
import { D1BotConnections } from "./d1-bot-connections.ts";
import { D1BotControl } from "./d1-bot-control.ts";
import { type BotConversationPlan, D1BotConversations } from "./d1-bot-conversations.ts";

const MAX_PUBLIC_BODY_LENGTH = 256 * 1024;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const CONNECTOR_SCOPES = new Set([
    "conversation-events:read",
    "inbound-conversation:create",
    "inbound-message:create",
    "outbound-message:ack",
    "outbound-message:read",
    "turn:cancel",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
        throw new BotApiError("invalid_request", "The request fields are invalid", 400);
    }
}

function string(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength: number,
    allowEmpty = false,
): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximumLength || (!allowEmpty && field.trim().length === 0)) {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function identifier(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = string(value, key, 128);
    if (!IDENTIFIER_PATTERN.test(field)) {
        throw new BotApiError("invalid_request", `The ${key} identifier is invalid`, 400);
    }
    return field;
}

function pathIdentifier(value: string, name: string): string {
    let decoded: string;
    try {
        decoded = decodeURIComponent(value);
    } catch (cause) {
        throw new BotApiError("invalid_request", `The ${name} identifier is invalid`, 400, { cause });
    }
    if (!IDENTIFIER_PATTERN.test(decoded)) {
        throw new BotApiError("invalid_request", `The ${name} identifier is invalid`, 400);
    }
    return decoded;
}

function integer(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function positiveInteger(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = integer(value, key);
    if (field < 1) {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return field;
}

function object(value: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
    const field = value[key];
    if (!isRecord(field)) {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, 400);
    }
    return Object.fromEntries(Object.entries(field));
}

function identifiers(value: Readonly<Record<string, unknown>>, key: string, maximumCount: number): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.length > maximumCount) {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, 400);
    }
    const result: string[] = [];
    const unique = new Set<string>();
    for (const candidate of field) {
        if (typeof candidate !== "string" || !IDENTIFIER_PATTERN.test(candidate) || unique.has(candidate)) {
            throw new BotApiError("invalid_request", `The ${key} field is invalid`, 400);
        }
        unique.add(candidate);
        result.push(candidate);
    }
    return result;
}

function connectorScopes(value: Readonly<Record<string, unknown>>): readonly string[] {
    const scopes = identifiers(value, "scopes", CONNECTOR_SCOPES.size);
    if (scopes.length === 0 || scopes.some((scope) => !CONNECTOR_SCOPES.has(scope))) {
        throw new BotApiError("invalid_request", "The Bot connection scopes are invalid", 400);
    }
    return scopes;
}

function completionPolicy(value: Readonly<Record<string, unknown>>): BotCompletionDeliveryPolicy {
    const policy = object(value, "completionPolicy");
    if (policy["kind"] === "none") {
        exact(policy, ["kind"]);
        return new NoBotCompletionDeliveryPolicy();
    }
    if (policy["kind"] === "required") {
        exact(policy, ["deliveryTargetId", "kind", "messageTemplate"]);
        return new RequiredBotCompletionDeliveryPolicy(
            identifier(policy, "deliveryTargetId"),
            string(policy, "messageTemplate", 10_000),
        );
    }
    throw new BotApiError("invalid_request", "The completionPolicy field is invalid", 400);
}

abstract class CreateBotConversationRequest {
    readonly clientConversationKey: string;
    readonly title: string;

    protected constructor(clientConversationKey: string, title: string) {
        this.clientConversationKey = clientConversationKey;
        this.title = title;
    }
}

class CreateOwnerBotConversationRequest extends CreateBotConversationRequest {
    constructor(clientConversationKey: string, title: string) {
        super(clientConversationKey, title);
    }
}

class CreateConnectedBotConversationRequest extends CreateBotConversationRequest {
    readonly replyDeliveryTargetId: string;

    constructor(clientConversationKey: string, title: string, replyDeliveryTargetId: string) {
        super(clientConversationKey, title);
        this.replyDeliveryTargetId = replyDeliveryTargetId;
    }
}

function createConversationRequest(value: Readonly<Record<string, unknown>>): CreateBotConversationRequest {
    const keys = Object.keys(value);
    if (keys.length === 2 && keys.every((key) => ["clientConversationKey", "title"].includes(key))) {
        return new CreateOwnerBotConversationRequest(
            identifier(value, "clientConversationKey"),
            string(value, "title", 500, true),
        );
    }
    if (
        keys.length === 3 &&
        keys.every((key) => ["clientConversationKey", "replyDeliveryTargetId", "title"].includes(key))
    ) {
        return new CreateConnectedBotConversationRequest(
            identifier(value, "clientConversationKey"),
            string(value, "title", 500, true),
            identifier(value, "replyDeliveryTargetId"),
        );
    }
    throw new BotApiError("invalid_request", "The request fields are invalid", 400);
}

class BotOutboundRequest {
    readonly idempotencyKey: string;
    readonly text: string;

    constructor(value: Readonly<Record<string, unknown>>) {
        exact(value, ["idempotencyKey", "text"]);
        this.idempotencyKey = identifier(value, "idempotencyKey");
        this.text = string(value, "text", 10_000);
    }
}

function connectorEventPayload(event: BotConversationEvent): Readonly<Record<string, unknown>> {
    if (event.kind === AGENT_MESSAGE_DELTA_KIND && typeof event.payload["text"] === "string") {
        return { kind: event.kind, text: event.payload["text"] };
    }
    if (event.kind === SESSION_COMPLETED_KIND && typeof event.payload["stopReason"] === "string") {
        return { kind: event.kind, stopReason: event.payload["stopReason"] };
    }
    if (event.kind === SESSION_FAILED_KIND && typeof event.payload["code"] === "string") {
        return { code: event.payload["code"], kind: event.kind };
    }
    if (event.kind === SESSION_PERMISSION_REQUESTED_KIND) {
        return { actionKind: "permission", actionRequired: true, kind: event.kind };
    }
    if (event.kind === SESSION_ELICITATION_REQUESTED_KIND) {
        return { actionKind: "elicitation", actionRequired: true, kind: event.kind };
    }
    if (event.kind === SESSION_PERMISSION_RESOLVED_KIND) {
        return { actionKind: "permission", actionRequired: false, kind: event.kind };
    }
    if (event.kind === SESSION_ELICITATION_RESOLVED_KIND) {
        return { actionKind: "elicitation", actionRequired: false, kind: event.kind };
    }
    return { kind: event.kind };
}

function connectorEventPage(page: BotConversationEventPage): BotConversationEventPage {
    return new BotConversationEventPage(
        page.cursor,
        page.events.map(
            (event) =>
                new BotConversationEvent(
                    event.eventId,
                    event.conversationId,
                    event.turnId,
                    event.sequence,
                    event.timestamp,
                    event.behaviorRevisionId,
                    event.kind,
                    connectorEventPayload(event),
                ),
        ),
        page.hasMore,
    );
}

async function requestBody(request: Request): Promise<Readonly<Record<string, unknown>>> {
    let encoded: string;
    try {
        encoded = await readBoundedUtf8Body(request, MAX_PUBLIC_BODY_LENGTH);
    } catch (cause) {
        if (cause instanceof RequestBodyError) {
            throw new BotApiError(
                "invalid_request",
                cause.code === "body_too_large" ? "The request body is too large" : "The request body is invalid",
                cause.code === "body_too_large" ? 413 : 400,
            );
        }
        throw cause;
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("invalid_request", "The request body is not valid JSON", 400, { cause });
    }
    if (!isRecord(value)) {
        throw new BotApiError("invalid_request", "The request body must be an object", 400);
    }
    return Object.fromEntries(Object.entries(value));
}

function bearer(request: Request): string {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
        throw new BotApiError("credential_invalid", "A bearer credential is required", 401);
    }
    const token = authorization.slice("Bearer ".length);
    if (!TOKEN_PATTERN.test(token)) {
        throw new BotApiError("credential_invalid", "The bearer credential is invalid", 401);
    }
    return token;
}

function executionCapability(request: Request): string {
    const capability = request.headers.get("x-mobius-bot-execution-capability") ?? "";
    if (!TOKEN_PATTERN.test(capability)) {
        throw new BotApiError("execution_context_required", "A Bot execution capability is required", 401);
    }
    return capability;
}

function cursor(url: URL): number {
    const after = url.searchParams.get("after") ?? "0";
    if (!CURSOR_PATTERN.test(after)) {
        throw new BotApiError("invalid_request", "The outbound cursor is invalid", 400);
    }
    const parsed = Number(after);
    if (!Number.isSafeInteger(parsed)) {
        throw new BotApiError("invalid_request", "The outbound cursor is invalid", 400);
    }
    return parsed;
}

function pageLimit(url: URL): number {
    const value = url.searchParams.get("limit") ?? "100";
    if (!/^[1-9][0-9]{0,2}$/.test(value)) {
        throw new BotApiError("invalid_request", "The page limit is invalid", 400);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > 100) {
        throw new BotApiError("invalid_request", "The page limit is invalid", 400);
    }
    return parsed;
}

export interface CloudflareBotApiEnvironment {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

export class CloudflareBotApi {
    readonly #authorization: D1BotAuthorization;
    readonly #channelRuntime: ChannelGateway;
    readonly #connectionRuntime: CloudflareBotConnectionRuntime;
    readonly #connections: D1BotConnections;
    readonly #control: D1BotControl;
    readonly #conversations: D1BotConversations;
    readonly #sessionRuntime: CloudflareBotSessionRuntime;
    readonly #sessions: CloudflareSessionRuntime;

    constructor(
        environment: CloudflareBotApiEnvironment,
        channelRuntime: ChannelGateway,
        sessions: CloudflareSessionRuntime,
    ) {
        this.#authorization = new D1BotAuthorization(environment.DIRECTORY_DATABASE);
        this.#channelRuntime = channelRuntime;
        this.#connectionRuntime = new CloudflareBotConnectionRuntime(environment.BOT_CONNECTIONS);
        this.#connections = new D1BotConnections(environment.DIRECTORY_DATABASE);
        this.#control = new D1BotControl(environment.DIRECTORY_DATABASE);
        this.#conversations = new D1BotConversations(environment.DIRECTORY_DATABASE);
        this.#sessionRuntime = new CloudflareBotSessionRuntime(environment.SESSION_RELAY, sessions);
        this.#sessions = sessions;
    }

    readonly handles = (request: Request): boolean => {
        const pathname = new URL(request.url).pathname;
        return pathname.startsWith(`${MOBIUS_API_PREFIX}/v1/`);
    };

    readonly fetch = async (request: Request): Promise<Response> => {
        try {
            return await this.route(request);
        } catch (error) {
            if (request.signal.aborted) {
                throw error;
            }
            return botErrorResponse(error);
        }
    };

    private readonly route = async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const relativePath = url.pathname.slice(MOBIUS_API_PREFIX.length);
        const segments = relativePath.split("/").filter((segment) => segment.length > 0);
        if (segments[0] !== "v1") {
            return new Response(null, { status: 404 });
        }
        const now = Date.now();
        if (
            request.method === "POST" &&
            segments.length === 4 &&
            segments[1] === "projects" &&
            segments[3] === "bots"
        ) {
            const projectId = pathIdentifier(segments[2] ?? "", "project");
            const value = await requestBody(request);
            exact(value, ["avatarRef", "description", "displayName"]);
            const access = await this.#authorization.authorizeProjectOwner(projectId, bearer(request), request.signal);
            return Response.json(
                await this.#control.createBot(
                    access,
                    string(value, "displayName", 80),
                    string(value, "avatarRef", 4_096, true),
                    string(value, "description", 2_000, true),
                    now,
                    request.signal,
                ),
                { status: 201 },
            );
        }
        if (segments.length >= 3 && segments[1] === "bots") {
            return await this.botRoute(request, segments, now);
        }
        if (
            request.method === "POST" &&
            segments.length === 3 &&
            segments[1] === "bot-connection-grants" &&
            segments[2] === "redeem"
        ) {
            const value = await requestBody(request);
            exact(value, ["audience", "connectorPrincipalId", "grantId", "grantSecret"]);
            return Response.json(
                await this.#connections.redeemGrant(
                    identifier(value, "grantId"),
                    string(value, "grantSecret", 256),
                    identifier(value, "audience"),
                    string(value, "connectorPrincipalId", 500),
                    now,
                    request.signal,
                ),
                { status: 201 },
            );
        }
        if (segments.length >= 3 && segments[1] === "bot-connections") {
            return await this.connectionRoute(request, segments, url, now);
        }
        if (segments.length >= 3 && segments[1] === "bot-executions") {
            return await this.executionRoute(request, segments, now);
        }
        return new Response(null, { status: 404 });
    };

    private readonly botRoute = async (
        request: Request,
        segments: readonly string[],
        now: number,
    ): Promise<Response> => {
        const botId = pathIdentifier(segments[2] ?? "", "Bot");
        if (request.method === "GET" && segments.length === 3) {
            const access = await this.#authorization.authorizeBotOwner(botId, bearer(request), request.signal);
            return Response.json(await this.#control.readBot(access, request.signal));
        }
        if (request.method === "POST" && segments.length === 4 && segments[3] === "profile-revisions") {
            const value = await requestBody(request);
            exact(value, ["avatarRef", "description", "displayName", "expectedRevision"]);
            const access = await this.#authorization.authorizeBotOwner(botId, bearer(request), request.signal);
            return Response.json(
                await this.#control.createProfileRevision(
                    access,
                    integer(value, "expectedRevision"),
                    string(value, "displayName", 80),
                    string(value, "avatarRef", 4_096, true),
                    string(value, "description", 2_000, true),
                    now,
                    request.signal,
                ),
                { status: 201 },
            );
        }
        if (request.method === "POST" && segments.length === 4 && segments[3] === "behavior-revisions") {
            const value = await requestBody(request);
            exact(value, ["agentConfiguration", "expectedRevision", "instructions", "requiredCapabilities"]);
            const requiredCapabilities = identifiers(value, "requiredCapabilities", 32);
            if (requiredCapabilities.some((capability) => capability !== "embedded-context")) {
                throw new BotApiError("invalid_request", "The behavior capability is not supported", 400);
            }
            const access = await this.#authorization.authorizeBotOwner(botId, bearer(request), request.signal);
            return Response.json(
                await this.#control.createBehaviorRevision(
                    access,
                    integer(value, "expectedRevision"),
                    string(value, "instructions", 100_000, true),
                    requiredCapabilities,
                    object(value, "agentConfiguration"),
                    now,
                    request.signal,
                ),
                { status: 201 },
            );
        }
        if (request.method === "POST" && segments.length === 4 && segments[3] === "execution-bindings") {
            const value = await requestBody(request);
            exact(value, [
                "agentConfigRevision",
                "agentRef",
                "allowedDeliveryTargetIds",
                "behaviorRevisionId",
                "completionPolicy",
                "expectedRevision",
                "runtimeId",
                "workspaceRef",
            ]);
            const access = await this.#authorization.authorizeBotOwner(botId, bearer(request), request.signal);
            const created = await this.#control.createExecutionBinding(
                access,
                integer(value, "expectedRevision"),
                identifier(value, "behaviorRevisionId"),
                identifier(value, "runtimeId"),
                identifier(value, "agentRef"),
                string(value, "workspaceRef", 2_048),
                positiveInteger(value, "agentConfigRevision"),
                identifiers(value, "allowedDeliveryTargetIds", 64),
                completionPolicy(value),
                now,
                request.signal,
            );
            await this.#channelRuntime.dispatchPending(created.runtimeAccess, request.signal);
            return Response.json(
                {
                    bindingId: created.bindingId,
                    bindingRevision: created.bindingRevision,
                    lifecycle: "requested",
                },
                { status: 202 },
            );
        }
        if (request.method === "POST" && segments.length === 4 && segments[3] === "connection-grants") {
            const value = await requestBody(request);
            exact(value, ["audience", "expiresInSeconds", "label", "scopes"]);
            const access = await this.#authorization.authorizeBotOwner(botId, bearer(request), request.signal);
            return Response.json(
                await this.#connections.createGrant(
                    access,
                    identifier(value, "audience"),
                    string(value, "label", 200),
                    connectorScopes(value),
                    integer(value, "expiresInSeconds"),
                    now,
                    request.signal,
                ),
                { status: 201 },
            );
        }
        if (
            request.method === "POST" &&
            segments.length === 6 &&
            segments[3] === "delivery-targets" &&
            segments[5] === "approve"
        ) {
            const value = await requestBody(request);
            exact(value, ["expectedPolicyRevision"]);
            const access = await this.#authorization.authorizeBotOwner(botId, bearer(request), request.signal);
            return Response.json(
                await this.#connections.approveTarget(
                    access,
                    pathIdentifier(segments[4] ?? "", "delivery target"),
                    integer(value, "expectedPolicyRevision"),
                    now,
                    request.signal,
                ),
            );
        }
        if (
            request.method === "POST" &&
            segments.length === 4 &&
            (segments[3] === "suspend" || segments[3] === "archive")
        ) {
            const value = await requestBody(request);
            exact(value, ["expectedRevision"]);
            const access = await this.#authorization.authorizeBotOwner(botId, bearer(request), request.signal);
            return Response.json(
                await this.#control.transitionBot(
                    access,
                    integer(value, "expectedRevision"),
                    segments[3] ?? "",
                    now,
                    request.signal,
                ),
            );
        }
        if (request.method === "POST" && segments.length === 4 && segments[3] === "conversations") {
            return await this.createConversation(request, botId, now);
        }
        if (
            request.method === "POST" &&
            segments.length === 6 &&
            segments[3] === "conversations" &&
            segments[5] === "messages"
        ) {
            return await this.submitMessage(request, botId, pathIdentifier(segments[4] ?? "", "conversation"), now);
        }
        if (
            request.method === "GET" &&
            segments.length === 6 &&
            segments[3] === "conversations" &&
            segments[5] === "events"
        ) {
            const principal = await this.#authorization.authorizeInbound(
                botId,
                bearer(request),
                "conversation-events:read",
                request.signal,
            );
            const conversation = await this.#conversations.authorizeConversation(
                principal,
                pathIdentifier(segments[4] ?? "", "conversation"),
                request.signal,
            );
            const after = new URL(request.url).searchParams.get("after");
            const page = await this.#sessionRuntime.readConversationEvents(
                principal.scope,
                conversation.sessionId,
                after ?? "",
                100,
                request.signal,
            );
            return Response.json(principal instanceof InboundBotConnectorPrincipal ? connectorEventPage(page) : page);
        }
        if (request.method === "POST" && segments.length === 6 && segments[3] === "turns" && segments[5] === "cancel") {
            const value = await requestBody(request);
            exact(value, ["idempotencyKey"]);
            const idempotencyKey = identifier(value, "idempotencyKey");
            const turnId = pathIdentifier(segments[4] ?? "", "turn");
            const principal = await this.#authorization.authorizeInbound(
                botId,
                bearer(request),
                "turn:cancel",
                request.signal,
            );
            const conversation = await this.#conversations.authorizeTurn(principal, turnId, request.signal);
            const runtimeId = await this.#sessions.readTurnRuntime(
                principal.scope,
                conversation.sessionId,
                turnId,
                request.signal,
            );
            const runtimeAccess = await this.#control.readRuntimeAccess(principal.scope, runtimeId, request.signal);
            const accepted = await this.#sessions.acceptTurnCancellation(
                principal.scope,
                runtimeId,
                conversation.sessionId,
                turnId,
                idempotencyKey,
                now,
                request.signal,
            );
            await this.#channelRuntime.dispatchPending(runtimeAccess, request.signal);
            return Response.json({ duplicate: accepted.duplicate, turnId: accepted.turn.turnId }, { status: 202 });
        }
        return new Response(null, { status: 404 });
    };

    private readonly createConversation = async (request: Request, botId: string, now: number): Promise<Response> => {
        const decoded = createConversationRequest(await requestBody(request));
        const principal = await this.#authorization.authorizeInbound(
            botId,
            bearer(request),
            "inbound-conversation:create",
            request.signal,
        );
        const binding = await this.#control.readApprovedBinding(botId, request.signal);
        let plan: BotConversationPlan;
        if (principal instanceof InboundBotOwnerPrincipal && decoded instanceof CreateOwnerBotConversationRequest) {
            plan = await this.#conversations.createOwnerConversation(
                principal,
                binding,
                decoded.clientConversationKey,
                decoded.title,
                now,
                request.signal,
            );
        } else if (
            principal instanceof InboundBotConnectorPrincipal &&
            decoded instanceof CreateConnectedBotConversationRequest
        ) {
            const targetId = decoded.replyDeliveryTargetId;
            await this.#connections.authorizeConversationReplyTarget(
                botId,
                principal.connection.connectionId,
                targetId,
                request.signal,
            );
            plan = await this.#conversations.createConnectedConversation(
                principal,
                binding,
                decoded.clientConversationKey,
                decoded.title,
                targetId,
                now,
                request.signal,
            );
        } else {
            throw new BotApiError("invalid_request", "The conversation request does not match its principal", 400);
        }
        await this.#sessionRuntime.provisionConversation(principal.scope, plan.provisioning, now, request.signal);
        return Response.json(
            await this.#conversations.activateConversation(
                principal.scope,
                plan.provisioning.conversationId,
                now,
                request.signal,
            ),
            { status: 201 },
        );
    };

    private readonly submitMessage = async (
        request: Request,
        botId: string,
        conversationId: string,
        now: number,
    ): Promise<Response> => {
        const value = await requestBody(request);
        exact(value, ["actorRef", "clientMessageId", "resourceRefs", "text"]);
        const resourceReferences = identifiers(value, "resourceRefs", 16);
        const submission = new BotTurnSubmission(
            identifier(value, "clientMessageId"),
            string(value, "actorRef", 500),
            string(value, "text", 100_000),
            [],
            [],
            resourceReferences.map((reference) => ({
                mimeType: "",
                name: reference,
                text: "",
                type: "link",
                uri: `mobius://resource/${encodeURIComponent(reference)}`,
            })),
        );
        const principal = await this.#authorization.authorizeInbound(
            botId,
            bearer(request),
            "inbound-message:create",
            request.signal,
        );
        const conversation = await this.#conversations.authorizeNewTurn(principal, conversationId, request.signal);
        const accepted = await this.#sessionRuntime.acceptTurn(
            principal.scope,
            conversation.sessionId,
            submission,
            now,
            request.signal,
        );
        await this.#conversations.registerExecution(principal.scope, accepted.execution, now, request.signal);
        const runtimeAccess = await this.#control.readRuntimeAccess(
            principal.scope,
            accepted.execution.runtimeId,
            request.signal,
        );
        await this.#channelRuntime.dispatchPending(runtimeAccess, request.signal);
        return Response.json(
            {
                duplicate: accepted.duplicate,
                eventCursor: "0",
                executionId: accepted.execution.executionId,
                turnId: accepted.execution.turnId,
            },
            { status: 202 },
        );
    };

    private readonly connectionRoute = async (
        request: Request,
        segments: readonly string[],
        url: URL,
        now: number,
    ): Promise<Response> => {
        const connectionId = pathIdentifier(segments[2] ?? "", "connection");
        if (
            request.method === "POST" &&
            segments.length === 5 &&
            segments[3] === "credentials" &&
            segments[4] === "rotate"
        ) {
            const value = await requestBody(request);
            exact(value, []);
            const access = await this.#authorization.authorizeConnectorManagement(
                connectionId,
                bearer(request),
                request.signal,
            );
            return Response.json(await this.#connections.rotateCredential(access, now, request.signal), {
                status: 201,
            });
        }
        if (request.method === "POST" && segments.length === 4 && segments[3] === "revoke") {
            const value = await requestBody(request);
            exact(value, []);
            const access = await this.#authorization.authorizeConnectorManagement(
                connectionId,
                bearer(request),
                request.signal,
            );
            return Response.json(await this.#connections.revokeConnection(access, now, request.signal));
        }
        if (request.method === "POST" && segments.length === 4 && segments[3] === "delivery-targets") {
            const value = await requestBody(request);
            exact(value, ["alias"]);
            const access = await this.#authorization.authorizeConnectorManagement(
                connectionId,
                bearer(request),
                request.signal,
            );
            return Response.json(
                await this.#connections.createTarget(access, identifier(value, "alias"), now, request.signal),
                { status: 201 },
            );
        }
        if (
            request.method === "POST" &&
            segments.length === 6 &&
            segments[3] === "delivery-targets" &&
            segments[5] === "disable"
        ) {
            const value = await requestBody(request);
            exact(value, []);
            const access = await this.#authorization.authorizeConnectorManagement(
                connectionId,
                bearer(request),
                request.signal,
            );
            return Response.json(
                await this.#connections.disableTarget(
                    access,
                    pathIdentifier(segments[4] ?? "", "delivery target"),
                    now,
                    request.signal,
                ),
            );
        }
        if (request.method === "GET" && segments.length === 4 && segments[3] === "outbound-events") {
            const access = await this.#authorization.authorizeConnector(
                connectionId,
                bearer(request),
                "outbound-message:read",
                request.signal,
            );
            return Response.json(
                await this.#connectionRuntime.read(
                    connectionId,
                    cursor(url),
                    pageLimit(url),
                    now,
                    await this.#connections.listActiveTargetIds(access.connectionId, request.signal),
                    request.signal,
                ),
            );
        }
        if (request.method === "POST" && segments.length === 6 && segments[3] === "outbound-messages") {
            const outboundMessageId = pathIdentifier(segments[4] ?? "", "outbound message");
            const access = await this.#authorization.authorizeConnector(
                connectionId,
                bearer(request),
                "outbound-message:ack",
                request.signal,
            );
            if (segments[5] === "delivered") {
                const value = await requestBody(request);
                exact(value, ["claimId"]);
                return Response.json(
                    await this.#connectionRuntime.delivered(
                        access.connectionId,
                        outboundMessageId,
                        identifier(value, "claimId"),
                        now,
                        request.signal,
                    ),
                );
            }
            if (segments[5] === "retryable-failure") {
                const value = await requestBody(request);
                exact(value, ["claimId", "code", "retryAfterSeconds"]);
                const retryAfterSeconds = integer(value, "retryAfterSeconds");
                if (retryAfterSeconds < 1 || retryAfterSeconds > 3_600) {
                    throw new BotApiError("invalid_request", "The retry delay is invalid", 400);
                }
                return Response.json(
                    await this.#connectionRuntime.retryableFailure(
                        access.connectionId,
                        outboundMessageId,
                        identifier(value, "claimId"),
                        identifier(value, "code"),
                        now + retryAfterSeconds * 1_000,
                        now,
                        request.signal,
                    ),
                );
            }
            if (segments[5] === "terminal-failure") {
                const value = await requestBody(request);
                exact(value, ["claimId", "code"]);
                return Response.json(
                    await this.#connectionRuntime.terminalFailure(
                        access.connectionId,
                        outboundMessageId,
                        identifier(value, "claimId"),
                        identifier(value, "code"),
                        now,
                        request.signal,
                    ),
                );
            }
        }
        return new Response(null, { status: 404 });
    };

    private readonly executionRoute = async (
        request: Request,
        segments: readonly string[],
        now: number,
    ): Promise<Response> => {
        if (request.method !== "POST") {
            return new Response(null, { status: 404 });
        }
        const executionId = pathIdentifier(segments[2] ?? "", "execution");
        if (segments.length === 4 && segments[3] === "reply-messages") {
            const outbound = new BotOutboundRequest(await requestBody(request));
            const capabilitySecret = executionCapability(request);
            const runtime = await this.#authorization.authorizeRuntimeExecution(
                executionId,
                bearer(request),
                request.signal,
            );
            await this.#sessionRuntime.authorizeExecutionCapability(
                runtime.scope,
                runtime.sessionId,
                runtime.executionId,
                capabilitySecret,
                now,
                request.signal,
            );
            const route = await this.#conversations.readReplyRoute(runtime.conversationId, request.signal);
            if (!(route instanceof BotConnectionReplyRoute)) {
                throw new BotApiError(
                    "delivery_target_not_allowed",
                    "The Bot conversation has no external reply target",
                    403,
                );
            }
            return await this.acceptOutbound(request, runtime, capabilitySecret, route.deliveryTargetId, outbound, now);
        }
        if (segments.length === 6 && segments[3] === "delivery-targets" && segments[5] === "messages") {
            const deliveryTargetId = pathIdentifier(segments[4] ?? "", "delivery target");
            const outbound = new BotOutboundRequest(await requestBody(request));
            const capabilitySecret = executionCapability(request);
            const runtime = await this.#authorization.authorizeRuntimeExecution(
                executionId,
                bearer(request),
                request.signal,
            );
            await this.#sessionRuntime.authorizeExecutionCapability(
                runtime.scope,
                runtime.sessionId,
                runtime.executionId,
                capabilitySecret,
                now,
                request.signal,
            );
            return await this.acceptOutbound(request, runtime, capabilitySecret, deliveryTargetId, outbound, now);
        }
        return new Response(null, { status: 404 });
    };

    private readonly acceptOutbound = async (
        request: Request,
        runtime: BotRuntimeExecutionAccess,
        capabilitySecret: string,
        deliveryTargetId: string,
        outbound: BotOutboundRequest,
        now: number,
    ): Promise<Response> => {
        const route = await this.#connections.authorizeOutboundTarget(
            runtime.botId,
            runtime.bindingId,
            deliveryTargetId,
            request.signal,
        );
        const accepted = await this.#sessionRuntime.acceptOutbound(
            runtime.scope,
            runtime.sessionId,
            runtime.executionId,
            capabilitySecret,
            new BotOutboundSubmission(outbound.idempotencyKey, route.deliveryTargetId, outbound.text),
            now,
            request.signal,
        );
        await this.#conversations.recordOutboundAccepted(
            runtime.scope,
            runtime.runtimeId,
            accepted,
            now,
            request.signal,
        );
        try {
            await this.#connectionRuntime.enqueue(route, accepted, request.signal);
            await this.#sessionRuntime.markOutboundForwarded(
                runtime.scope,
                runtime.sessionId,
                accepted.outboundMessageId,
                now,
                request.signal,
            );
        } catch (error) {
            request.signal.throwIfAborted();
            console.error("Bot outbound forwarding will be reconciled", error);
        }
        return Response.json(
            { duplicate: accepted.duplicate, outboundMessageId: accepted.outboundMessageId },
            { status: 202 },
        );
    };
}
