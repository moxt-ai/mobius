import {
    BotConversationEvent,
    BotConversationEventPage,
    BotExecutionRecord,
    BotOutboundAcceptance,
    type BotOutboundSubmission,
    type BotSessionProvisioning,
    type BotSessionRuntime,
    BotSessionRuntimeError,
    BotTurnAcceptance,
    type BotTurnSubmission,
    PendingBotOutbound,
    type ProjectScope,
} from "@moxt-ai/mobius-relay-core";

import type { CloudflareSessionRuntime } from "./cloudflare-session-runtime.ts";

const MAX_INTERNAL_RESPONSE_LENGTH = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: Readonly<Record<string, unknown>>, key: string, allowEmpty = false): string {
    const field = value[key];
    if (typeof field !== "string" || (!allowEmpty && field.length === 0)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot Session returned invalid data");
    }
    return field;
}

function integer(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot Session returned invalid data");
    }
    return field;
}

function boolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
    const field = value[key];
    if (typeof field !== "boolean") {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot Session returned invalid data");
    }
    return field;
}

function record(value: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
    const field = value[key];
    if (!isRecord(field)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot Session returned invalid data");
    }
    return Object.fromEntries(Object.entries(field));
}

function decodeConversationEvent(value: unknown): BotConversationEvent {
    if (!isRecord(value)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot conversation event is invalid");
    }
    return new BotConversationEvent(
        text(value, "eventId"),
        text(value, "conversationId"),
        text(value, "turnId"),
        text(value, "sequence"),
        text(value, "timestamp"),
        text(value, "behaviorRevisionId"),
        text(value, "kind"),
        record(value, "payload"),
    );
}

function decodeExecution(value: unknown): BotExecutionRecord {
    if (!isRecord(value)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot execution is invalid");
    }
    return new BotExecutionRecord(
        text(value, "executionId"),
        text(value, "capabilityId"),
        text(value, "botId"),
        text(value, "conversationId"),
        text(value, "sessionId"),
        text(value, "turnId"),
        text(value, "behaviorRevisionId"),
        text(value, "bindingId"),
        integer(value, "bindingRevision"),
        text(value, "runtimeId"),
        text(value, "deadlineAt"),
    );
}

function decodeOutbound(value: unknown): BotOutboundAcceptance {
    if (!isRecord(value)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The outbound acceptance is invalid");
    }
    return new BotOutboundAcceptance(
        text(value, "outboundMessageId"),
        text(value, "botId"),
        text(value, "conversationId"),
        text(value, "turnId"),
        text(value, "behaviorRevisionId"),
        text(value, "bindingId"),
        integer(value, "bindingRevision"),
        text(value, "executionId"),
        text(value, "deliveryTargetId"),
        text(value, "idempotencyKey"),
        text(value, "text", true),
        text(value, "acceptedAt"),
        text(value, "expiresAt"),
        boolean(value, "duplicate"),
    );
}

function decodePendingOutbound(value: unknown): PendingBotOutbound {
    if (!isRecord(value)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The pending outbound message is invalid");
    }
    return new PendingBotOutbound(
        text(value, "outboundMessageId"),
        text(value, "botId"),
        text(value, "conversationId"),
        text(value, "turnId"),
        text(value, "behaviorRevisionId"),
        text(value, "bindingId"),
        integer(value, "bindingRevision"),
        text(value, "executionId"),
        text(value, "deliveryTargetId"),
        text(value, "idempotencyKey"),
        text(value, "text", true),
        text(value, "acceptedAt"),
        text(value, "expiresAt"),
    );
}

function runtimeErrorCode(value: string): string {
    const allowed = new Set([
        "conversation_access_denied",
        "delivery_target_not_allowed",
        "execution_capability_expired",
        "execution_capability_invalid",
        "idempotency_conflict",
        "invalid_request",
        "queue_full",
        "session_busy",
        "session_storage_unavailable",
    ]);
    return allowed.has(value) ? value : "session_storage_unavailable";
}

export class CloudflareBotSessionRuntime implements BotSessionRuntime {
    readonly #namespace: DurableObjectNamespace;
    readonly #sessions: CloudflareSessionRuntime;

    constructor(namespace: DurableObjectNamespace, sessions: CloudflareSessionRuntime) {
        this.#namespace = namespace;
        this.#sessions = sessions;
    }

    readonly authorizeExecutionCapability = async (
        scope: ProjectScope,
        sessionId: string,
        executionId: string,
        capabilitySecret: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.request(
            scope,
            sessionId,
            "bot-execution-authorize",
            { capabilitySecret, executionId, now, sessionId },
            signal,
        );
    };

    readonly provisionConversation = async (
        scope: ProjectScope,
        provisioning: BotSessionProvisioning,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.request(scope, provisioning.sessionId, "bot-provision", { now, provisioning }, signal);
        await this.#sessions.readSession(scope, provisioning.sessionId, signal);
    };

    readonly acceptTurn = async (
        scope: ProjectScope,
        sessionId: string,
        submission: BotTurnSubmission,
        now: number,
        signal: AbortSignal,
    ): Promise<BotTurnAcceptance> => {
        const value = await this.request(scope, sessionId, "bot-accept", { now, sessionId, submission }, signal);
        if (!isRecord(value)) {
            throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot turn acceptance is invalid");
        }
        await this.#sessions.readSession(scope, sessionId, signal);
        return new BotTurnAcceptance(decodeExecution(value["execution"]), boolean(value, "duplicate"));
    };

    readonly acceptOutbound = async (
        scope: ProjectScope,
        sessionId: string,
        executionId: string,
        capabilitySecret: string,
        submission: BotOutboundSubmission,
        now: number,
        signal: AbortSignal,
    ): Promise<BotOutboundAcceptance> =>
        decodeOutbound(
            await this.request(
                scope,
                sessionId,
                "bot-outbound-accept",
                { capabilitySecret, executionId, now, sessionId, submission },
                signal,
            ),
        );

    readonly listPendingOutbound = async (
        scope: ProjectScope,
        sessionId: string,
        limit: number,
        now: number,
        signal: AbortSignal,
    ): Promise<readonly PendingBotOutbound[]> => {
        const value = await this.request(scope, sessionId, "bot-outbound-pending", { limit, now, sessionId }, signal);
        if (!Array.isArray(value)) {
            throw new BotSessionRuntimeError("session_storage_unavailable", "The pending outbound list is invalid");
        }
        return value.map(decodePendingOutbound);
    };

    readonly readConversationEvents = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<BotConversationEventPage> => {
        const value = await this.request(
            scope,
            sessionId,
            "bot-conversation-events",
            { cursor, limit, sessionId },
            signal,
        );
        if (!isRecord(value) || !Array.isArray(value["events"])) {
            throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot event page is invalid");
        }
        return new BotConversationEventPage(
            text(value, "cursor", true),
            value["events"].map(decodeConversationEvent),
            boolean(value, "hasMore"),
        );
    };

    readonly markOutboundForwarded = async (
        scope: ProjectScope,
        sessionId: string,
        outboundMessageId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.request(scope, sessionId, "bot-outbound-forwarded", { now, outboundMessageId, sessionId }, signal);
    };

    readonly markOutboundTerminalFailure = async (
        scope: ProjectScope,
        sessionId: string,
        outboundMessageId: string,
        failureCode: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.request(
            scope,
            sessionId,
            "bot-outbound-terminal-failure",
            { failureCode, now, outboundMessageId, sessionId },
            signal,
        );
    };

    readonly settleExecution = async (
        scope: ProjectScope,
        sessionId: string,
        commandId: string,
        outcome: string,
        now: number,
        signal: AbortSignal,
    ): Promise<readonly PendingBotOutbound[]> => {
        const value = await this.request(
            scope,
            sessionId,
            "bot-execution-settle",
            { commandId, now, outcome, sessionId },
            signal,
        );
        if (!Array.isArray(value)) {
            throw new BotSessionRuntimeError("session_storage_unavailable", "The settled outbound list is invalid");
        }
        return value.map(decodePendingOutbound);
    };

    private readonly request = async (
        scope: ProjectScope,
        sessionId: string,
        operation: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ): Promise<unknown> => {
        signal.throwIfAborted();
        const objectId = this.#namespace.idFromName(`${scope.tenantId}:${scope.projectId}:${sessionId}`);
        let response: Response;
        try {
            response = await this.#namespace.get(objectId).fetch(
                new Request(`https://session.internal/internal/sessions/${operation}`, {
                    body: JSON.stringify({ ...body, scope }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal,
                }),
            );
        } catch (cause) {
            signal.throwIfAborted();
            throw new BotSessionRuntimeError(
                "session_storage_unavailable",
                "The Bot Session Durable Object is unavailable",
                { cause },
            );
        }
        signal.throwIfAborted();
        const encoded = await response.text();
        if (encoded.length === 0 || encoded.length > MAX_INTERNAL_RESPONSE_LENGTH) {
            throw new BotSessionRuntimeError(
                "session_storage_unavailable",
                "The Bot Session Durable Object returned an invalid response",
            );
        }
        let value: unknown;
        try {
            value = JSON.parse(encoded);
        } catch (cause) {
            throw new BotSessionRuntimeError(
                "session_storage_unavailable",
                "The Bot Session Durable Object returned invalid JSON",
                { cause },
            );
        }
        if (!response.ok) {
            if (isRecord(value) && isRecord(value["error"])) {
                const code = value["error"]["code"];
                const message = value["error"]["message"];
                if (typeof code === "string" && typeof message === "string") {
                    throw new BotSessionRuntimeError(runtimeErrorCode(code), message);
                }
            }
            throw new BotSessionRuntimeError(
                "session_storage_unavailable",
                "The Bot Session Durable Object rejected the operation",
            );
        }
        return value;
    };
}
