import { BotApiError, type BotConnectionGateway, type BotOutboundAcceptance } from "@moxt-ai/mobius-relay-core";

type BotDeliveryRoute = Parameters<BotConnectionGateway["enqueue"]>[0];

const MAX_INTERNAL_RESPONSE_LENGTH = 64 * 1024;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deliveryError(code: unknown, message: unknown): BotApiError | null {
    if (typeof message !== "string") {
        return null;
    }
    switch (code) {
        case "connection_storage_unavailable":
            return new BotApiError(code, message, "unavailable");
        case "connection_not_found":
            return new BotApiError(code, message, "not-found");
        case "idempotency_conflict":
        case "revision_conflict":
            return new BotApiError(code, message, "conflict");
        case "invalid_request":
            return new BotApiError(code, message, "invalid-input");
        case "queue_full":
            return new BotApiError(code, message, "capacity-exceeded");
        default:
            return null;
    }
}

export class CloudflareBotConnectionRuntime implements BotConnectionGateway {
    readonly #namespace: DurableObjectNamespace;

    constructor(namespace: DurableObjectNamespace) {
        this.#namespace = namespace;
    }

    readonly enqueue = async (
        route: BotDeliveryRoute,
        message: BotOutboundAcceptance,
        signal: AbortSignal,
    ): Promise<object> =>
        await this.request(
            route.connectionId,
            "enqueue",
            {
                acceptedAt: message.acceptedAt,
                behaviorRevisionId: message.behaviorRevisionId,
                bindingId: message.bindingId,
                bindingRevision: message.bindingRevision,
                botId: message.botId,
                connectionId: route.connectionId,
                conversationId: message.conversationId,
                deliveryTargetId: message.deliveryTargetId,
                executionId: message.executionId,
                expiresAt: message.expiresAt,
                idempotencyKey: message.idempotencyKey,
                outboundMessageId: message.outboundMessageId,
                text: message.text,
                turnId: message.turnId,
            },
            signal,
        );

    readonly read = async (
        connectionId: string,
        after: number,
        limit: number,
        now: number,
        activeDeliveryTargetIds: readonly string[],
        signal: AbortSignal,
    ): Promise<object> =>
        await this.request(connectionId, "read", { activeDeliveryTargetIds, after, connectionId, limit, now }, signal);

    readonly delivered = async (
        connectionId: string,
        outboundMessageId: string,
        claimId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<object> =>
        await this.request(connectionId, "delivered", { claimId, connectionId, now, outboundMessageId }, signal);

    readonly retryableFailure = async (
        connectionId: string,
        outboundMessageId: string,
        claimId: string,
        code: string,
        retryAt: number,
        now: number,
        signal: AbortSignal,
    ): Promise<object> =>
        await this.request(
            connectionId,
            "retryable-failure",
            { claimId, code, connectionId, now, outboundMessageId, retryAt },
            signal,
        );

    readonly terminalFailure = async (
        connectionId: string,
        outboundMessageId: string,
        claimId: string,
        code: string,
        now: number,
        signal: AbortSignal,
    ): Promise<object> =>
        await this.request(
            connectionId,
            "terminal-failure",
            { claimId, code, connectionId, now, outboundMessageId },
            signal,
        );

    private readonly request = async (
        connectionId: string,
        operation: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ): Promise<object> => {
        signal.throwIfAborted();
        const id = this.#namespace.idFromName(connectionId);
        let response: Response;
        try {
            response = await this.#namespace.get(id).fetch(
                new Request(`https://connection.internal/internal/bot-connections/${operation}`, {
                    body: JSON.stringify(body),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal,
                }),
            );
        } catch (cause) {
            signal.throwIfAborted();
            throw new BotApiError(
                "connection_storage_unavailable",
                "The Bot connection delivery stream is unavailable",
                "unavailable",
                { cause },
            );
        }
        const encoded = await response.text();
        if (encoded.length === 0 || encoded.length > MAX_INTERNAL_RESPONSE_LENGTH) {
            throw new BotApiError(
                "connection_storage_unavailable",
                "The Bot connection delivery stream returned an invalid response",
                "unavailable",
            );
        }
        let value: unknown;
        try {
            value = JSON.parse(encoded);
        } catch (cause) {
            throw new BotApiError(
                "connection_storage_unavailable",
                "The Bot connection delivery stream returned invalid JSON",
                "unavailable",
                { cause },
            );
        }
        if (!response.ok) {
            if (isRecord(value) && isRecord(value["error"])) {
                const code = value["error"]["code"];
                const message = value["error"]["message"];
                const failure = deliveryError(code, message);
                if (failure !== null) {
                    throw failure;
                }
            }
            throw new BotApiError(
                "connection_storage_unavailable",
                "The Bot connection delivery stream rejected the operation",
                "unavailable",
            );
        }
        if (!isRecord(value)) {
            throw new BotApiError(
                "connection_storage_unavailable",
                "The Bot connection delivery stream returned invalid data",
                "unavailable",
            );
        }
        return Object.fromEntries(Object.entries(value));
    };
}
