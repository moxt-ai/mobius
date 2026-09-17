import { decodePromptImagesValue, decodePromptResourcesValue } from "@moxt-ai/mobius-protocol";
import { ExecutionPermit } from "../../entity/authentication/project-authentication.ts";
import {
    BotConversationEvent,
    BotConversationEventPage,
    type BotConversationMessage,
    BotConversationMessagePage,
    BotExecutionRecord,
    BotOutboundAcceptance,
    type BotOutboundSubmission,
    type BotSessionProvisioning,
    type BotSessionRuntime,
    BotSessionRuntimeError,
    BotTurnAcceptance,
    type BotTurnSubmission,
    PendingBotOutbound,
} from "../../entity/bot/bot-session.ts";
import { ProjectScope, type SessionSummary } from "../../entity/do/session.ts";
import type { SessionDirectoryGateway } from "../../gateway/session-directory-gateway.ts";
import type { SessionQueryGateway } from "../../gateway/session-query-gateway.ts";
import type { SessionTransport } from "../../gateway/session-transport.ts";
import type { OperationTiming } from "../../infra/operation-timing.ts";
import {
    decodeRemoteActivitySummaries,
    decodeRemoteAttemptSummary,
    decodeSessionSummary,
} from "../do/remote-session-runtime.ts";

const MAX_INTERNAL_RESPONSE_LENGTH = 8 * 1024 * 1024;
const MAX_INTERNAL_TIMING_LENGTH = 2 * 1024;
const internalTimingMetric = /^([a-z][a-z0-9-]{0,63});dur=(\d+(?:\.\d+)?);desc="([^"\\]{1,120})"$/u;
const provisionTimingDescriptions: Readonly<Record<string, string>> = {
    "context-insert": "Insert Bot Session context",
    "context-read": "Read Bot Session context",
    "existing-session-read": "Read existing conversation Session",
    "recovery-session-read": "Read concurrently created conversation Session",
    "session-create": "Create conversation Session",
};
const EXECUTION_PERMIT_FIELDS = Object.freeze([
    "allowedTargetIds",
    "behaviorRevisionId",
    "bindingId",
    "bindingRevision",
    "botId",
    "capabilityId",
    "conversationId",
    "executionId",
    "expiresAtEpochMilliseconds",
    "operation",
    "projectId",
    "remainingUses",
    "runtimeId",
    "sessionId",
    "turnId",
]);

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

function stringList(value: Readonly<Record<string, unknown>>, key: string): readonly string[] {
    const field = value[key];
    if (
        !Array.isArray(field) ||
        field.length > 64 ||
        field.some((candidate) => typeof candidate !== "string" || candidate.length === 0)
    ) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot Session returned invalid data");
    }
    return field.filter((candidate) => typeof candidate === "string");
}

function decodeExecutionPermit(value: unknown, expectedScope: ProjectScope): ExecutionPermit {
    if (!isRecord(value)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The execution permit is invalid");
    }
    const keys = Object.keys(value);
    if (keys.length !== EXECUTION_PERMIT_FIELDS.length || keys.some((key) => !EXECUTION_PERMIT_FIELDS.includes(key))) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The execution permit is invalid");
    }
    const projectId = text(value, "projectId");
    if (projectId !== expectedScope.projectId) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The execution permit scope is invalid");
    }
    return new ExecutionPermit(
        new ProjectScope(projectId),
        text(value, "capabilityId"),
        text(value, "executionId"),
        text(value, "botId"),
        text(value, "conversationId"),
        text(value, "sessionId"),
        text(value, "turnId"),
        text(value, "behaviorRevisionId"),
        text(value, "bindingId"),
        integer(value, "bindingRevision"),
        text(value, "runtimeId"),
        text(value, "operation"),
        new Set(stringList(value, "allowedTargetIds")),
        integer(value, "expiresAtEpochMilliseconds"),
        integer(value, "remainingUses"),
    );
}

function infrastructureScope(scope: ProjectScope): Readonly<Record<string, string>> {
    return {
        projectId: scope.projectId,
    };
}

function recordProvisionTimings(encoded: string | null, timing: OperationTiming): number {
    if (encoded === null || encoded.length > MAX_INTERNAL_TIMING_LENGTH) {
        return 0;
    }
    let measuredMilliseconds = 0;
    for (const entry of encoded.split(",")) {
        const match = internalTimingMetric.exec(entry.trim());
        if (match === null) {
            continue;
        }
        const [, name, duration] = match;
        if (name === undefined || duration === undefined) {
            continue;
        }
        const description = provisionTimingDescriptions[name];
        const durationMilliseconds = Number(duration);
        if (
            description === undefined ||
            !Number.isFinite(durationMilliseconds) ||
            durationMilliseconds < 0 ||
            durationMilliseconds > 120_000
        ) {
            continue;
        }
        timing.record(`create-provision-session-runtime-${name}`, description, durationMilliseconds);
        measuredMilliseconds += durationMilliseconds;
    }
    return measuredMilliseconds;
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

function decodeConversationMessage(value: unknown): BotConversationMessage {
    if (!isRecord(value)) {
        throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot conversation message is invalid");
    }
    return {
        activities: decodeRemoteActivitySummaries(value["activities"]),
        additionalDirectoryIds: stringList(value, "additionalDirectoryIds"),
        attempt: decodeRemoteAttemptSummary(value["attempt"]),
        behaviorRevisionId: text(value, "behaviorRevisionId"),
        clientMessageId: text(value, "clientMessageId"),
        createdAt: text(value, "createdAt"),
        disposition: text(value, "disposition"),
        executionId: text(value, "executionId"),
        images: decodePromptImagesValue(value["images"]),
        messageId: text(value, "messageId", true),
        prompt: text(value, "prompt", true),
        resources: decodePromptResourcesValue(value["resources"]),
        response: text(value, "response", true),
        targetClientMessageId: text(value, "targetClientMessageId", true),
        turnId: text(value, "turnId"),
    };
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
        "cursor_expired",
        "delivery_target_not_allowed",
        "execution_capability_expired",
        "execution_capability_invalid",
        "idempotency_conflict",
        "invalid_cursor",
        "invalid_request",
        "queue_full",
        "session_busy",
        "session_conflict",
        "session_storage_unavailable",
    ]);
    return allowed.has(value) ? value : "session_storage_unavailable";
}

export class RemoteBotSessionRuntime implements BotSessionRuntime {
    readonly #directory: SessionDirectoryGateway;
    readonly #transport: SessionTransport;
    readonly #sessions: SessionQueryGateway;

    constructor(transport: SessionTransport, sessions: SessionQueryGateway, directory: SessionDirectoryGateway) {
        this.#directory = directory;
        this.#transport = transport;
        this.#sessions = sessions;
    }

    readonly authorizeExecutionCapability = async (
        scope: ProjectScope,
        sessionId: string,
        executionId: string,
        capabilitySecret: string,
        now: number,
        signal: AbortSignal,
    ): Promise<ExecutionPermit> =>
        decodeExecutionPermit(
            await this.request(
                scope,
                sessionId,
                "bot-execution-authorize",
                { capabilitySecret, executionId, now, sessionId },
                signal,
            ),
            scope,
        );

    readonly provisionConversation = async (
        scope: ProjectScope,
        provisioning: BotSessionProvisioning,
        now: number,
        signal: AbortSignal,
        timing: OperationTiming,
    ): Promise<SessionSummary> => {
        const startedAt = performance.now();
        const summary = await timing.measure(
            "create-provision-session-runtime",
            "Provision Session runtime state",
            async () => {
                const response = await this.requestWithMetadata(
                    scope,
                    provisioning.sessionId,
                    "bot-provision",
                    { now, provisioning },
                    signal,
                );
                const measuredMilliseconds = recordProvisionTimings(response.serverTiming, timing);
                timing.record(
                    "create-provision-session-runtime-boundary",
                    "Reach Session runtime Durable Object",
                    Math.max(0, performance.now() - startedAt - measuredMilliseconds),
                );
                return decodeSessionSummary(response.value);
            },
        );
        await timing.measure(
            "create-provision-directory-sync",
            "Synchronize Session directory",
            async () => await this.#directory.synchronizeSession(summary, signal),
        );
        return summary;
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

    readonly promoteQueuedTurnToSteering = async (
        scope: ProjectScope,
        sessionId: string,
        turnId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<BotExecutionRecord> =>
        decodeExecution(await this.request(scope, sessionId, "bot-turn-promote", { now, sessionId, turnId }, signal));

    readonly readConversationEvents = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        limit: number,
        waitMilliseconds: number,
        signal: AbortSignal,
    ): Promise<BotConversationEventPage> => {
        const value = await this.request(
            scope,
            sessionId,
            "bot-conversation-events",
            { cursor, limit, sessionId, waitMilliseconds },
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

    readonly readConversationMessages = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<BotConversationMessagePage> => {
        const value = await this.request(
            scope,
            sessionId,
            "bot-conversation-messages",
            { cursor, limit, sessionId },
            signal,
        );
        if (!isRecord(value) || !Array.isArray(value["messages"])) {
            throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot message page is invalid");
        }
        const lastCommittedSequence = text(value, "lastCommittedSequence");
        if (!/^(?:0|[1-9][0-9]*)$/.test(lastCommittedSequence)) {
            throw new BotSessionRuntimeError("session_storage_unavailable", "The Bot message sequence is invalid");
        }
        return new BotConversationMessagePage(
            text(value, "conversationId"),
            value["messages"].map(decodeConversationMessage),
            text(value, "nextCursor", true),
            lastCommittedSequence,
            text(value, "tailEventCursor"),
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
    ): Promise<unknown> => (await this.requestWithMetadata(scope, sessionId, operation, body, signal)).value;

    private readonly requestWithMetadata = async (
        scope: ProjectScope,
        sessionId: string,
        operation: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ): Promise<{ readonly serverTiming: string | null; readonly value: unknown }> => {
        signal.throwIfAborted();
        let response: Response;
        try {
            response = await this.#transport.fetch(
                scope,
                sessionId,
                new Request(`https://session.internal/internal/sessions/${operation}`, {
                    body: JSON.stringify({ ...body, scope: infrastructureScope(scope) }),
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
        return { serverTiming: response.headers.get("server-timing"), value };
    };
}
