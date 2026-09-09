import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";

import {
    MobiusBotConnectionCredential,
    MobiusBotConnectionCredentialRotation,
    MobiusBotConversationEventPage,
    MobiusBotDeliveryAcknowledgement,
    MobiusBotDeliveryTarget,
    MobiusBotOutboundEventPage,
    MobiusBotTurnAcceptance,
    MobiusBotTurnCancellationAcceptance,
    MobiusConnectedBotConversation,
    MobiusDisabledBotDeliveryTarget,
    MobiusRevokedBotConnection,
} from "./bot-resources.ts";
import {
    MobiusApiError,
    MobiusCancellationError,
    MobiusConnectionError,
    MobiusError,
    MobiusProtocolError,
    MobiusTimeoutError,
    MobiusValidationError,
} from "./errors.ts";
import type { MobiusCredentialProvider, MobiusHttpTransport } from "./service-client.ts";

export const MOBIUS_BOT_API_VERSION = "v1";

const DEFAULT_OPERATION_TIMEOUT_MILLISECONDS = 20_000;
const MAX_RESPONSE_LENGTH = 8 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

export interface MobiusBotApiOptions {
    readonly endpoint: string;
    readonly operationTimeoutMilliseconds?: number;
    readonly transport?: MobiusHttpTransport;
}

export interface MobiusBotConnectorClientOptions extends MobiusBotApiOptions {
    readonly connectionId: string;
    readonly credentialProvider: MobiusCredentialProvider;
}

export interface RedeemMobiusBotConnectionGrantRequest {
    readonly audience: string;
    readonly connectorPrincipalId: string;
    readonly grantId: string;
    readonly grantSecret: string;
}

export interface CreateMobiusBotDeliveryTargetRequest {
    readonly alias: string;
}

export interface CreateMobiusConnectedConversationRequest {
    readonly clientConversationKey: string;
    readonly replyDeliveryTargetId: string;
    readonly title: string;
}

export interface SubmitMobiusBotMessageRequest {
    readonly actorRef: string;
    readonly clientMessageId: string;
    readonly resourceRefs: readonly string[];
    readonly text: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestRecord(value: unknown, fields: readonly string[], name: string): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    const keys = Object.keys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
        throw new MobiusValidationError(`The ${name} fields are invalid`);
    }
    return value;
}

function identifier(value: unknown, name: string): string {
    if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
        throw new MobiusValidationError(`The ${name} identifier is invalid`);
    }
    return value;
}

function boundedText(value: unknown, name: string, maximum: number, allowEmpty = false): string {
    if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.trim().length === 0)) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    return value;
}

function token(value: unknown, name: string): string {
    if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    return value;
}

function identifiers(value: unknown, name: string, maximum: number): readonly string[] {
    if (!Array.isArray(value) || value.length > maximum) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    const normalized: string[] = [];
    const unique = new Set<string>();
    for (const candidate of value) {
        const validated = identifier(candidate, name);
        if (unique.has(validated)) {
            throw new MobiusValidationError(`The ${name} contains a duplicate`);
        }
        unique.add(validated);
        normalized.push(validated);
    }
    return Object.freeze(normalized);
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    return value;
}

function normalizeEndpoint(value: string): URL {
    let endpoint: URL;
    try {
        endpoint = new URL(value);
    } catch (cause) {
        throw new MobiusValidationError("The Mobius Bot API endpoint is invalid", { cause });
    }
    if (
        (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
        endpoint.username.length > 0 ||
        endpoint.password.length > 0 ||
        endpoint.search.length > 0 ||
        endpoint.hash.length > 0
    ) {
        throw new MobiusValidationError("The Mobius Bot API endpoint is invalid");
    }
    if (endpoint.pathname === "/") {
        endpoint.pathname = `${MOBIUS_API_PREFIX}/`;
    } else if (!endpoint.pathname.endsWith("/")) {
        endpoint.pathname = `${endpoint.pathname}/`;
    }
    return endpoint;
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw new MobiusProtocolError("The Bot API returned an invalid error response");
    }
    return value;
}

abstract class BotRequestAuthentication {
    abstract readonly apply: (headers: Headers, signal: AbortSignal) => Promise<void>;
}

class AnonymousBotRequestAuthentication extends BotRequestAuthentication {
    readonly apply = async (_headers: Headers, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
    };
}

class CredentialBotRequestAuthentication extends BotRequestAuthentication {
    readonly #provider: MobiusCredentialProvider;

    constructor(provider: MobiusCredentialProvider) {
        super();
        this.#provider = provider;
    }

    readonly apply = async (headers: Headers, signal: AbortSignal): Promise<void> => {
        headers.set("authorization", `Bearer ${token(await this.#provider.credential(signal), "Mobius credential")}`);
    };
}

class PlatformMobiusBotTransport implements MobiusHttpTransport {
    readonly fetch = async (request: Request): Promise<Response> => await globalThis.fetch(request);
}

class BotRequestDeadline {
    readonly #controller = new AbortController();
    readonly #requestSignal: AbortSignal;
    readonly #timeoutId: ReturnType<typeof globalThis.setTimeout>;
    #timedOut = false;

    constructor(requestSignal: AbortSignal, timeoutMilliseconds: number) {
        this.#requestSignal = requestSignal;
        if (requestSignal.aborted) {
            this.#controller.abort(requestSignal.reason);
        } else {
            requestSignal.addEventListener("abort", this.abortFromRequest, { once: true });
        }
        this.#timeoutId = globalThis.setTimeout(this.abortFromTimeout, timeoutMilliseconds);
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    readonly finish = (): void => {
        globalThis.clearTimeout(this.#timeoutId);
        this.#requestSignal.removeEventListener("abort", this.abortFromRequest);
    };

    readonly translate = (cause: unknown): never => {
        if (this.#requestSignal.aborted) {
            throw new MobiusCancellationError({ cause });
        }
        if (this.#timedOut) {
            throw new MobiusTimeoutError({ cause });
        }
        if (cause instanceof MobiusError) {
            throw cause;
        }
        throw new MobiusConnectionError("The Mobius Bot API could not be reached", { cause });
    };

    private readonly abortFromRequest = (): void => this.#controller.abort(this.#requestSignal.reason);

    private readonly abortFromTimeout = (): void => {
        this.#timedOut = true;
        this.#controller.abort(new Error("The Mobius Bot API operation timed out"));
    };
}

class BotRequestExecutor {
    readonly #authentication: BotRequestAuthentication;
    readonly #endpoint: URL;
    readonly #operationTimeoutMilliseconds: number;
    readonly #transport: MobiusHttpTransport;

    constructor(options: MobiusBotApiOptions, authentication: BotRequestAuthentication) {
        this.#authentication = authentication;
        this.#endpoint = normalizeEndpoint(options.endpoint);
        this.#operationTimeoutMilliseconds = boundedInteger(
            options.operationTimeoutMilliseconds ?? DEFAULT_OPERATION_TIMEOUT_MILLISECONDS,
            "operation timeout",
            1,
            300_000,
        );
        this.#transport = options.transport ?? new PlatformMobiusBotTransport();
    }

    readonly get = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "GET", "", false, signal);

    readonly post = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string") {
            throw new MobiusValidationError("The Mobius Bot API request is invalid");
        }
        return await this.request(path, "POST", encoded, true, signal);
    };

    private readonly request = async (
        path: string,
        method: string,
        encodedBody: string,
        includesBody: boolean,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const deadline = new BotRequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const headers = new Headers({ accept: "application/json" });
            if (includesBody) {
                headers.set("content-type", "application/json");
            }
            await this.#authentication.apply(headers, deadline.signal);
            const url = new URL(path, this.#endpoint);
            const request = includesBody
                ? new Request(url, { body: encodedBody, headers, method, signal: deadline.signal })
                : new Request(url, { headers, method, signal: deadline.signal });
            const response = await this.#transport.fetch(request);
            deadline.signal.throwIfAborted();
            const encoded = await response.text();
            if (encoded.length === 0 || encoded.length > MAX_RESPONSE_LENGTH) {
                throw new MobiusProtocolError("The Mobius Bot API returned an invalid response");
            }
            let value: unknown;
            try {
                value = JSON.parse(encoded);
            } catch (cause) {
                throw new MobiusProtocolError("The Mobius Bot API returned invalid JSON", { cause });
            }
            if (!response.ok) {
                const error = responseRecord(responseRecord(value)["error"]);
                const code = error["code"];
                const message = error["message"];
                if (typeof code !== "string" || typeof message !== "string") {
                    throw new MobiusProtocolError("The Mobius Bot API returned an invalid error response");
                }
                throw new MobiusApiError(code, message, response.status);
            }
            return value;
        } catch (cause) {
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };
}

function botPath(botId: string, resource: string): string {
    return `${MOBIUS_BOT_API_VERSION}/bots/${encodeURIComponent(identifier(botId, "Bot"))}/${resource}`;
}

function connectionPath(connectionId: string, resource: string): string {
    return `${MOBIUS_BOT_API_VERSION}/bot-connections/${encodeURIComponent(identifier(connectionId, "connection"))}/${resource}`;
}

export class MobiusBotConnectionResources {
    readonly #connectionId: string;
    readonly #executor: BotRequestExecutor;

    constructor(executor: BotRequestExecutor, connectionId: string) {
        this.#executor = executor;
        this.#connectionId = connectionId;
    }

    readonly rotateCredential = async (signal: AbortSignal): Promise<MobiusBotConnectionCredentialRotation> =>
        new MobiusBotConnectionCredentialRotation(
            await this.#executor.post(connectionPath(this.#connectionId, "credentials/rotate"), {}, signal),
        );

    readonly revoke = async (signal: AbortSignal): Promise<MobiusRevokedBotConnection> =>
        new MobiusRevokedBotConnection(
            await this.#executor.post(connectionPath(this.#connectionId, "revoke"), {}, signal),
        );
}

export class MobiusBotDeliveryTargetResources {
    readonly #connectionId: string;
    readonly #executor: BotRequestExecutor;

    constructor(executor: BotRequestExecutor, connectionId: string) {
        this.#executor = executor;
        this.#connectionId = connectionId;
    }

    readonly create = async (
        request: CreateMobiusBotDeliveryTargetRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotDeliveryTarget> => {
        const value = requestRecord(request, ["alias"], "Bot delivery target request");
        return new MobiusBotDeliveryTarget(
            await this.#executor.post(
                connectionPath(this.#connectionId, "delivery-targets"),
                { alias: identifier(value["alias"], "delivery target alias") },
                signal,
            ),
        );
    };

    readonly disable = async (
        deliveryTargetId: string,
        signal: AbortSignal,
    ): Promise<MobiusDisabledBotDeliveryTarget> =>
        new MobiusDisabledBotDeliveryTarget(
            await this.#executor.post(
                connectionPath(
                    this.#connectionId,
                    `delivery-targets/${encodeURIComponent(identifier(deliveryTargetId, "delivery target"))}/disable`,
                ),
                {},
                signal,
            ),
        );
}

export class MobiusBotConversationResources {
    readonly #executor: BotRequestExecutor;

    constructor(executor: BotRequestExecutor) {
        this.#executor = executor;
    }

    readonly create = async (
        botId: string,
        request: CreateMobiusConnectedConversationRequest,
        signal: AbortSignal,
    ): Promise<MobiusConnectedBotConversation> => {
        const value = requestRecord(
            request,
            ["clientConversationKey", "replyDeliveryTargetId", "title"],
            "connected Bot conversation request",
        );
        return new MobiusConnectedBotConversation(
            await this.#executor.post(
                botPath(botId, "conversations"),
                {
                    clientConversationKey: identifier(value["clientConversationKey"], "client conversation"),
                    replyDeliveryTargetId: identifier(value["replyDeliveryTargetId"], "reply delivery target"),
                    title: boundedText(value["title"], "Bot conversation title", 500, true),
                },
                signal,
            ),
        );
    };

    readonly submitMessage = async (
        botId: string,
        conversationId: string,
        request: SubmitMobiusBotMessageRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotTurnAcceptance> => {
        const value = requestRecord(
            request,
            ["actorRef", "clientMessageId", "resourceRefs", "text"],
            "Bot message request",
        );
        return new MobiusBotTurnAcceptance(
            await this.#executor.post(
                botPath(
                    botId,
                    `conversations/${encodeURIComponent(identifier(conversationId, "conversation"))}/messages`,
                ),
                {
                    actorRef: boundedText(value["actorRef"], "external actor reference", 500),
                    clientMessageId: identifier(value["clientMessageId"], "client message"),
                    resourceRefs: identifiers(value["resourceRefs"], "resource reference", 16),
                    text: boundedText(value["text"], "Bot message text", 100_000),
                },
                signal,
            ),
        );
    };

    readonly readEvents = async (
        botId: string,
        conversationId: string,
        after: string,
        signal: AbortSignal,
    ): Promise<MobiusBotConversationEventPage> => {
        const path = new URL(
            botPath(botId, `conversations/${encodeURIComponent(identifier(conversationId, "conversation"))}/events`),
            "https://mobius.invalid/",
        );
        if (after.length > 0) {
            path.searchParams.set("after", boundedText(after, "Bot event cursor", 512));
        }
        return new MobiusBotConversationEventPage(
            await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal),
        );
    };

    readonly cancelTurn = async (
        botId: string,
        turnId: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<MobiusBotTurnCancellationAcceptance> =>
        new MobiusBotTurnCancellationAcceptance(
            await this.#executor.post(
                botPath(botId, `turns/${encodeURIComponent(identifier(turnId, "turn"))}/cancel`),
                { idempotencyKey: identifier(idempotencyKey, "cancellation idempotency key") },
                signal,
            ),
        );
}

export class MobiusBotOutboundMessageResources {
    readonly #connectionId: string;
    readonly #executor: BotRequestExecutor;

    constructor(executor: BotRequestExecutor, connectionId: string) {
        this.#executor = executor;
        this.#connectionId = connectionId;
    }

    readonly read = async (after: number, limit: number, signal: AbortSignal): Promise<MobiusBotOutboundEventPage> => {
        const path = new URL(connectionPath(this.#connectionId, "outbound-events"), "https://mobius.invalid/");
        path.searchParams.set("after", boundedInteger(after, "outbound cursor", 0, Number.MAX_SAFE_INTEGER).toString());
        path.searchParams.set("limit", boundedInteger(limit, "outbound page limit", 1, 100).toString());
        return new MobiusBotOutboundEventPage(
            await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal),
        );
    };

    readonly delivered = async (
        outboundMessageId: string,
        claimId: string,
        signal: AbortSignal,
    ): Promise<MobiusBotDeliveryAcknowledgement> =>
        await this.acknowledge(outboundMessageId, "delivered", { claimId: identifier(claimId, "claim") }, signal);

    readonly retryableFailure = async (
        outboundMessageId: string,
        claimId: string,
        code: string,
        retryAfterSeconds: number,
        signal: AbortSignal,
    ): Promise<MobiusBotDeliveryAcknowledgement> =>
        await this.acknowledge(
            outboundMessageId,
            "retryable-failure",
            {
                claimId: identifier(claimId, "claim"),
                code: identifier(code, "failure code"),
                retryAfterSeconds: boundedInteger(retryAfterSeconds, "retry delay", 1, 3_600),
            },
            signal,
        );

    readonly terminalFailure = async (
        outboundMessageId: string,
        claimId: string,
        code: string,
        signal: AbortSignal,
    ): Promise<MobiusBotDeliveryAcknowledgement> =>
        await this.acknowledge(
            outboundMessageId,
            "terminal-failure",
            { claimId: identifier(claimId, "claim"), code: identifier(code, "failure code") },
            signal,
        );

    private readonly acknowledge = async (
        outboundMessageId: string,
        outcome: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ): Promise<MobiusBotDeliveryAcknowledgement> =>
        new MobiusBotDeliveryAcknowledgement(
            await this.#executor.post(
                connectionPath(
                    this.#connectionId,
                    `outbound-messages/${encodeURIComponent(identifier(outboundMessageId, "outbound message"))}/${outcome}`,
                ),
                body,
                signal,
            ),
        );
}

export class MobiusBotConnectorClient {
    readonly connection: MobiusBotConnectionResources;
    readonly conversations: MobiusBotConversationResources;
    readonly deliveryTargets: MobiusBotDeliveryTargetResources;
    readonly outboundMessages: MobiusBotOutboundMessageResources;

    constructor(options: MobiusBotConnectorClientOptions) {
        const connectionId = identifier(options.connectionId, "connection");
        const executor = new BotRequestExecutor(
            options,
            new CredentialBotRequestAuthentication(options.credentialProvider),
        );
        this.connection = new MobiusBotConnectionResources(executor, connectionId);
        this.conversations = new MobiusBotConversationResources(executor);
        this.deliveryTargets = new MobiusBotDeliveryTargetResources(executor, connectionId);
        this.outboundMessages = new MobiusBotOutboundMessageResources(executor, connectionId);
    }
}

export function createMobiusBotConnectorClient(options: MobiusBotConnectorClientOptions): MobiusBotConnectorClient {
    return new MobiusBotConnectorClient(options);
}

export async function redeemMobiusBotConnectionGrant(
    options: MobiusBotApiOptions,
    request: RedeemMobiusBotConnectionGrantRequest,
    signal: AbortSignal,
): Promise<MobiusBotConnectionCredential> {
    const value = requestRecord(
        request,
        ["audience", "connectorPrincipalId", "grantId", "grantSecret"],
        "Bot connection grant redemption",
    );
    const executor = new BotRequestExecutor(options, new AnonymousBotRequestAuthentication());
    return new MobiusBotConnectionCredential(
        await executor.post(
            `${MOBIUS_BOT_API_VERSION}/bot-connection-grants/redeem`,
            {
                audience: identifier(value["audience"], "connector audience"),
                connectorPrincipalId: boundedText(value["connectorPrincipalId"], "connector principal", 500),
                grantId: identifier(value["grantId"], "connection grant"),
                grantSecret: token(value["grantSecret"], "connection grant secret"),
            },
            signal,
        ),
    );
}
