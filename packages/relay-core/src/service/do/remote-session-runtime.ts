import {
    type Attempt,
    decodeAgentDisplayContentValue,
    decodeAttempt as decodeAttemptResource,
    decodeCommittedSessionEvent,
    decodeInteraction,
    decodeInteractionResponse,
    decodeNativeMessagePage,
    decodeNativeSessionHistory,
    decodePendingWork,
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeSessionConfigUpdatedEvent,
    decodeTurn,
    encodeSessionConfigureCommand,
    encodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    type Interaction,
    type InteractionResponse,
    type NativeMessagePage,
    type NativeSessionHistory,
    type PendingWork,
    type SessionConfigureCommand,
    type SessionEventEnvelope,
    type SessionPromptCommand,
    type Turn,
} from "@moxt-ai/mobius-protocol";
import type { RuntimeDisconnectTarget } from "../../entity/channel/runtime-connection.ts";
import {
    type ActivityDetail,
    type AttemptReconciliationOutcome,
    type CommittedEventResult,
    type CreateSessionBindingRequest,
    type CreateSessionRequest,
    type InteractionResponseAcceptance,
    isSessionDirectoryIdentifier,
    type PendingDaemonDelivery,
    type ProjectScope,
    SessionConfigurationAcceptance,
    SessionConfigurationSnapshot,
    type SessionDirectoryPage,
    type SessionEventPage,
    type SessionExport,
    type SessionLifecycle,
    type SessionMessage,
    type SessionMessagePage,
    type SessionQuotaPolicyProvider,
    SessionRuntimeError,
    type SessionSummary,
    type TurnAcceptance,
    type TurnCancellationAcceptance,
} from "../../entity/do/session.ts";
import type { SessionTransport } from "../../gateway/session-transport.ts";
import { COMPRESSED_JSON_ENCODING, decompressJsonBody } from "../../infra/compressed-json.ts";
import {
    DO_TIMING_HEADER,
    DO_TIMING_NAME_PREFIX,
    decodeOperationTiming,
    type OperationTiming,
    unmeasuredOperationTiming,
} from "../../infra/operation-timing.ts";
import type { ProjectStorageDirectory } from "../../infra/project-storage-directory.ts";
import type {
    SessionCommandRuntime,
    SessionEventStreamRuntime,
    SessionQueryRuntime,
    SessionTransferRuntime,
} from "../../infra/session-runtime.ts";
import type { SessionDirectoryStorage } from "../../storage/session-directory-storage.ts";
import { validateCreateSessionRequest } from "./session-records.ts";

const SESSION_OPERATION_TIMEOUT_MILLISECONDS = 20_000;

/**
 * A Runtime relay handles its Sessions, and asking it for pending delivery work
 * costs a nested round trip. Probing them one at a time made a Runtime attach scale with the Project's
 * Session count and exceed the daemon's connection deadline, which left the Channel unable to reconnect.
 * Bound the probes so attach latency tracks this concurrency instead of the Session count, matching the
 * Runtime message scheduler's bounded concurrency for the same kind of nested Session request.
 */
const SESSION_PROBE_CONCURRENCY = 8;

const MAX_INTERNAL_RESPONSE_LENGTH = 96 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DECIMAL_SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/;

type SessionReservation = { readonly kind: "existing" } | { readonly kind: "reserved" };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readString(value: Readonly<Record<string, unknown>>, key: string, allowEmpty = false): string {
    const field = value[key];
    if (typeof field !== "string" || (!allowEmpty && field.length === 0)) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session storage returned an invalid record");
    }
    return field;
}

function readNumber(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session storage returned an invalid record");
    }
    return field;
}

function readBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
    const field = value[key];
    if (typeof field !== "boolean") {
        throw new SessionRuntimeError("session_storage_unavailable", "The session storage returned an invalid record");
    }
    return field;
}

function readDirectoryIdentifiers(value: Readonly<Record<string, unknown>>, key: string): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.length > 16) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session storage returned an invalid record");
    }
    const identifiers: string[] = [];
    const unique = new Set<string>();
    for (const identifier of field) {
        if (typeof identifier !== "string" || !isSessionDirectoryIdentifier(identifier) || unique.has(identifier)) {
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The session storage returned an invalid record",
            );
        }
        identifiers.push(identifier);
        unique.add(identifier);
    }
    return identifiers;
}

function decodeLifecycle(value: unknown): SessionLifecycle {
    if (!isRecord(value)) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session lifecycle is invalid");
    }
    const kind = value["kind"];
    if (kind === "ready") {
        return { kind };
    }
    if (kind === "deleting") {
        return { kind, requestedAt: readString(value, "requestedAt") };
    }
    if (kind === "deleted") {
        return { completedAt: readString(value, "completedAt"), kind };
    }
    throw new SessionRuntimeError("session_storage_unavailable", "The session lifecycle is invalid");
}

function decodeSessionSummary(value: unknown): SessionSummary {
    if (!isRecord(value) || !isRecord(value["policy"]) || !isRecord(value["defaultBinding"])) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session summary is invalid");
    }
    const policy = value["policy"];
    const defaultBinding = value["defaultBinding"];
    const level = policy["level"];
    if (level !== "full" && level !== "summary") {
        throw new SessionRuntimeError("session_storage_unavailable", "The session policy is invalid");
    }
    const busyStatus = value["busyStatus"];
    if (busyStatus !== undefined && busyStatus !== "working" && busyStatus !== "failed") {
        throw new SessionRuntimeError("session_storage_unavailable", "The session busy status is invalid");
    }
    return {
        agentId: readString(value, "agentId"),
        ...(busyStatus === undefined ? {} : { busyStatus }),
        createdAt: readString(value, "createdAt"),
        createdBy: readString(value, "createdBy"),
        defaultBinding: {
            agentRef: readString(defaultBinding, "agentRef"),
            bindingId: readString(defaultBinding, "bindingId"),
            configRevision: readNumber(defaultBinding, "configRevision"),
            createdAt: readString(defaultBinding, "createdAt"),
            runtimeId: readString(defaultBinding, "runtimeId"),
            sessionId: readString(defaultBinding, "sessionId"),
            workspaceRef: readString(defaultBinding, "workspaceRef"),
        },
        hasNativeHistory: readBoolean(value, "hasNativeHistory"),
        lastCommittedSeq: readString(value, "lastCommittedSeq"),
        lifecycle: decodeLifecycle(value["lifecycle"]),
        policy: {
            contentLimitBytes: readNumber(policy, "contentLimitBytes"),
            hotEventLimit: readNumber(policy, "hotEventLimit"),
            idempotencyRetentionMilliseconds: readNumber(policy, "idempotencyRetentionMilliseconds"),
            level,
            retentionMilliseconds: readNumber(policy, "retentionMilliseconds"),
        },
        projectId: readString(value, "projectId"),
        runtimeId: readString(value, "runtimeId"),
        sessionId: readString(value, "sessionId"),
        title: readString(value, "title", true),
        updatedAt: readString(value, "updatedAt"),
    };
}

function decodeConfiguration(value: unknown): SessionConfigurationSnapshot {
    if (!isRecord(value) || !Array.isArray(value["options"])) {
        throw new SessionRuntimeError("session_storage_unavailable", "The Session configuration is invalid");
    }
    try {
        const event = decodeSessionConfigUpdatedEvent(
            JSON.stringify({
                configOptions: value["options"],
                kind: "session.config.updated",
                requestId: "remote-configuration",
                sessionId: "remote-session",
            }),
        );
        return new SessionConfigurationSnapshot(
            event.configOptions,
            readNumber(value, "revision"),
            readString(value, "updatedAt"),
        );
    } catch (cause) {
        if (cause instanceof SessionRuntimeError) {
            throw cause;
        }
        throw new SessionRuntimeError("session_storage_unavailable", "The Session configuration is invalid", {
            cause,
        });
    }
}

function decodeRemoteAttemptSummary(value: unknown): SessionMessage["attempt"] {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session attempt is invalid");
    }
    const kind = value["kind"];
    if (kind === "dispatching") {
        return {
            attemptId: readString(value, "attemptId"),
            dispatchedAt: readString(value, "dispatchedAt"),
            kind,
        };
    }
    if (kind === "running") {
        return {
            kind,
            attemptId: readString(value, "attemptId"),
            startedAt: readString(value, "startedAt"),
        };
    }
    if (kind === "waiting_input") {
        const interactionIds = value["interactionIds"];
        if (
            !Array.isArray(interactionIds) ||
            interactionIds.length === 0 ||
            interactionIds.some((interactionId) => typeof interactionId !== "string" || interactionId.length === 0)
        ) {
            throw new SessionRuntimeError("session_storage_unavailable", "The waiting Attempt is invalid");
        }
        return {
            attemptId: readString(value, "attemptId"),
            interactionIds: interactionIds.filter((interactionId) => typeof interactionId === "string"),
            kind,
            startedAt: readString(value, "startedAt"),
        };
    }
    if (kind === "succeeded") {
        return {
            completedAt: readString(value, "completedAt"),
            kind,
            attemptId: readString(value, "attemptId"),
            startedAt: readString(value, "startedAt"),
            stopReason: readString(value, "stopReason"),
        };
    }
    if (kind === "indeterminate") {
        return {
            detectedAt: readString(value, "detectedAt"),
            kind,
            attemptId: readString(value, "attemptId"),
            startedAt: readString(value, "startedAt"),
        };
    }
    if (kind === "cancelled") {
        return {
            attemptId: readString(value, "attemptId"),
            cancelledAt: readString(value, "cancelledAt"),
            kind,
            startedAt: readString(value, "startedAt"),
        };
    }
    if (kind === "failed") {
        const attemptId = value["attemptId"];
        const startedAt = value["startedAt"];
        if (
            (attemptId !== null && typeof attemptId !== "string") ||
            (startedAt !== null && typeof startedAt !== "string")
        ) {
            throw new SessionRuntimeError("session_storage_unavailable", "The failed attempt is invalid");
        }
        return {
            code: readString(value, "code"),
            failedAt: readString(value, "failedAt"),
            kind,
            message: readString(value, "message", true),
            attemptId,
            startedAt,
        };
    }
    throw new SessionRuntimeError("session_storage_unavailable", "The session attempt state is invalid");
}

function decodeRemoteActivitySummaries(value: unknown): SessionMessage["activities"] {
    if (!Array.isArray(value)) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session activities are invalid");
    }
    return value.map((activity) => {
        if (!isRecord(activity) || !Array.isArray(activity["locations"])) {
            throw new SessionRuntimeError("session_storage_unavailable", "The activity summary is invalid");
        }
        const detailAvailability = activity["detailAvailability"];
        if (
            detailAvailability !== "available" &&
            detailAvailability !== "truncated" &&
            detailAvailability !== "unrecorded"
        ) {
            throw new SessionRuntimeError("session_storage_unavailable", "The activity availability is invalid");
        }
        const locations = activity["locations"];
        if (locations.some((location) => typeof location !== "string")) {
            throw new SessionRuntimeError("session_storage_unavailable", "The activity locations are invalid");
        }
        const availability: SessionMessage["activities"][number]["detailAvailability"] = detailAvailability;
        return {
            activityId: readString(activity, "activityId"),
            attemptId: readString(activity, "attemptId"),
            activityType: readString(activity, "activityType"),
            detailAvailability: availability,
            input: readString(activity, "input", true),
            locations: locations.filter((location) => typeof location === "string"),
            name: readString(activity, "name", true),
            output: readString(activity, "output", true),
            sequence: readNumber(activity, "sequence"),
            status: readString(activity, "status"),
            title: readString(activity, "title"),
            toolCallId: readString(activity, "toolCallId"),
            toolKind: readString(activity, "toolKind", true),
        };
    });
}

function decodeMessage(value: unknown): SessionMessage {
    if (!isRecord(value) || !Array.isArray(value["activities"]) || !Array.isArray(value["contents"])) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session message is invalid");
    }
    const activities = decodeRemoteActivitySummaries(value["activities"]);
    return {
        activities,
        additionalDirectoryIds: readDirectoryIdentifiers(value, "additionalDirectoryIds"),
        agentId: readString(value, "agentId"),
        attempt: decodeRemoteAttemptSummary(value["attempt"]),
        commandId: readString(value, "commandId"),
        contents: value["contents"].map(decodeAgentDisplayContentValue),
        createdAt: readString(value, "createdAt"),
        disposition: readString(value, "disposition"),
        images: decodePromptImagesValue(value["images"]),
        messageId: readString(value, "messageId", true),
        prompt: readString(value, "prompt", true),
        resources: decodePromptResourcesValue(value["resources"]),
        response: readString(value, "response", true),
        sessionId: readString(value, "sessionId"),
        targetCommandId: readString(value, "targetCommandId", true),
        turnId: readString(value, "turnId", true),
    };
}

function _decodeMessages(value: unknown): SessionMessagePage {
    if (!isRecord(value) || !Array.isArray(value["messages"])) {
        throw new SessionRuntimeError("session_storage_unavailable", "The message page is invalid");
    }
    const nextCursor = value["nextCursor"];
    if (nextCursor !== null && typeof nextCursor !== "string") {
        throw new SessionRuntimeError("session_storage_unavailable", "The message cursor is invalid");
    }
    const lastCommittedSeq = readString(value, "lastCommittedSeq");
    if (lastCommittedSeq.length > 40 || !DECIMAL_SEQUENCE_PATTERN.test(lastCommittedSeq)) {
        throw new SessionRuntimeError("session_storage_unavailable", "The message page sequence is invalid");
    }
    return {
        lastCommittedSeq,
        messages: value["messages"].map(decodeMessage),
        nextCursor,
        tailEventCursor: readString(value, "tailEventCursor"),
    };
}

function decodeEvents(value: unknown): SessionEventPage {
    if (!isRecord(value) || !Array.isArray(value["events"])) {
        throw new SessionRuntimeError("session_storage_unavailable", "The event page is invalid");
    }
    const hasMore = value["hasMore"];
    if (typeof hasMore !== "boolean") {
        throw new SessionRuntimeError("session_storage_unavailable", "The event page is invalid");
    }
    return {
        cursor: readString(value, "cursor"),
        events: value["events"].map((event) => decodeCommittedSessionEvent(JSON.stringify(event))),
        hasMore,
    };
}

function decodeDetail(value: unknown): ActivityDetail {
    if (!isRecord(value)) {
        throw new SessionRuntimeError("session_storage_unavailable", "The activity detail is invalid");
    }
    const kind = value["kind"];
    if (kind === "unrecorded") {
        return { kind };
    }
    if (kind === "deleted") {
        return { deletedAt: readString(value, "deletedAt"), kind };
    }
    if (kind === "truncated") {
        return {
            capturedBytes: readNumber(value, "capturedBytes"),
            kind,
            originalBytes: readNumber(value, "originalBytes"),
        };
    }
    if (kind === "available" && Array.isArray(value["content"])) {
        const storage = value["storage"];
        if (storage !== "archive" && storage !== "hot") {
            throw new SessionRuntimeError("session_storage_unavailable", "The activity storage state is invalid");
        }
        return {
            artifactId: readString(value, "artifactId"),
            content: value["content"],
            input: readString(value, "input", true),
            kind,
            output: readString(value, "output", true),
            storage,
        };
    }
    throw new SessionRuntimeError("session_storage_unavailable", "The activity detail is invalid");
}

function runtimeErrorCode(value: string): SessionRuntimeError["code"] {
    switch (value) {
        case "artifact_content_mismatch":
        case "artifact_not_found":
        case "artifact_not_ready":
        case "artifact_upload_closed":
        case "artifact_upload_expired":
        case "artifact_upload_unauthorized":
        case "content_too_large":
        case "cursor_expired":
        case "invalid_cursor":
        case "invalid_export":
        case "invalid_page_size":
        case "idempotency_conflict":
        case "interaction_conflict":
        case "interaction_not_found":
        case "invalid_request":
        case "event_source_conflict":
        case "pending_work_not_found":
        case "session_access_denied":
        case "session_busy":
        case "session_conflict":
        case "session_deleted":
        case "session_history_not_retained":
        case "session_not_found":
        case "session_quota_exceeded":
        case "session_storage_timeout":
        case "session_storage_unavailable":
            return value;
        default:
            return "session_storage_unavailable";
    }
}

/**
 * Internal responses may be gzip encoded so that large Session pages do not spend the Worker's body budget on
 * verbatim text. The Durable Object transport does not negotiate encoding, so honour the declared one explicitly.
 */
async function readResponseBytes(response: Response): Promise<Uint8Array> {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INTERNAL_RESPONSE_LENGTH) {
        throw new SessionRuntimeError("session_storage_unavailable", "The Runtime relay returned an invalid response");
    }
    return bytes;
}

async function decodeResponseBytes(response: Response, bytes: Uint8Array): Promise<unknown> {
    let value: unknown;
    if (response.headers.get("content-encoding") === COMPRESSED_JSON_ENCODING) {
        try {
            value = await decompressJsonBody(bytes, MAX_INTERNAL_RESPONSE_LENGTH);
        } catch (cause) {
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The Runtime relay returned an invalid response",
                { cause },
            );
        }
    } else {
        try {
            value = JSON.parse(new TextDecoder().decode(bytes));
        } catch (cause) {
            throw new SessionRuntimeError("session_storage_unavailable", "The Runtime relay returned invalid JSON", {
                cause,
            });
        }
    }
    return rejectFailedResponse(response, value);
}

/** Translates a Durable Object error payload into the typed Session error contract. */
function rejectFailedResponse(response: Response, value: unknown): unknown {
    if (response.ok) {
        return value;
    }
    if (isRecord(value) && isRecord(value["error"])) {
        const code = value["error"]["code"];
        const message = value["error"]["message"];
        if (typeof code === "string" && typeof message === "string") {
            throw new SessionRuntimeError(runtimeErrorCode(code), message);
        }
    }
    throw new SessionRuntimeError("session_storage_unavailable", "The Runtime relay rejected the operation");
}

function encodeDirectoryCursor(scope: ProjectScope, updatedAt: number, sessionId: string): string {
    return btoa(
        JSON.stringify({
            projectId: scope.projectId,
            sessionId,
            updatedAt,
        }),
    )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

function infrastructureScope(scope: ProjectScope): Readonly<Record<string, string>> {
    return { projectId: scope.projectId };
}

function decodeDirectoryCursor(
    encoded: string,
    scope: ProjectScope,
): { readonly sessionId: string; readonly updatedAt: number } {
    try {
        if (!/^[A-Za-z0-9_-]{1,512}$/.test(encoded)) {
            throw new Error("Invalid cursor alphabet");
        }
        const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
        const padding = "=".repeat((4 - (base64.length % 4)) % 4);
        const value: unknown = JSON.parse(atob(`${base64}${padding}`));
        if (
            !isRecord(value) ||
            !hasExactKeys(value, ["projectId", "sessionId", "updatedAt"]) ||
            value["projectId"] !== scope["projectId"] ||
            typeof value["sessionId"] !== "string" ||
            typeof value["updatedAt"] !== "number" ||
            !Number.isSafeInteger(value["updatedAt"])
        ) {
            throw new Error("Invalid cursor fields");
        }
        return { sessionId: value["sessionId"], updatedAt: value["updatedAt"] };
    } catch (cause) {
        throw new SessionRuntimeError("invalid_cursor", "The cursor is invalid", {
            cause,
        });
    }
}

export class RemoteSessionRuntime
    implements SessionCommandRuntime, SessionQueryRuntime, SessionTransferRuntime, SessionEventStreamRuntime
{
    readonly #directory: SessionDirectoryStorage;
    readonly #projects: ProjectStorageDirectory;
    readonly #transport: SessionTransport;
    readonly #quotaPolicy: SessionQuotaPolicyProvider;

    constructor(cx: {
        readonly storages: {
            readonly directory: SessionDirectoryStorage;
            readonly projects: ProjectStorageDirectory;
        };
        readonly gateways: { readonly transport: SessionTransport };
        readonly config: { readonly quotaPolicy: SessionQuotaPolicyProvider };
    }) {
        this.#directory = cx.storages.directory;
        this.#projects = cx.storages.projects;
        this.#transport = cx.gateways.transport;
        this.#quotaPolicy = cx.config.quotaPolicy;
    }

    readonly createSession = async (
        scope: ProjectScope,
        request: CreateSessionRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        validateCreateSessionRequest(request);
        await this.reserveSession(scope, request.sessionId, now, signal);
        const summary = decodeSessionSummary(
            await this.requestCreating(scope, request.sessionId, "create", { now, request }, request.runtimeId, signal),
        );
        await this.updateDirectory(summary, signal);
        return summary;
    };

    readonly acceptTurn = async (
        scope: ProjectScope,
        runtimeId: string,
        command: SessionPromptCommand,
        now: number,
        signal: AbortSignal,
    ): Promise<TurnAcceptance> => {
        const encodedCommand = encodeSessionPromptCommand(command);
        await this.reserveSession(scope, command.sessionId, now, signal);
        const value = await this.request(
            scope,
            command.sessionId,
            "accept",
            { command: encodedCommand, now, runtimeId },
            signal,
        );
        if (!isRecord(value) || (value["kind"] !== "accepted" && value["kind"] !== "duplicate")) {
            throw new SessionRuntimeError("session_storage_unavailable", "The command acceptance result is invalid");
        }
        if (value["kind"] === "accepted") {
            await this.refreshDirectory(scope, command.sessionId, signal);
            return {
                kind: "accepted",
                pendingWork: decodePendingWork(value["pendingWork"]),
                turn: decodeTurn(value["turn"]),
            };
        }
        const state = value["state"];
        if (
            state !== "queued" &&
            state !== "running" &&
            state !== "succeeded" &&
            state !== "failed" &&
            state !== "cancelled" &&
            state !== "indeterminate"
        ) {
            throw new SessionRuntimeError("session_storage_unavailable", "The duplicate command state is invalid");
        }
        return {
            kind: "duplicate",
            pendingWork: value["pendingWork"] === null ? null : decodePendingWork(value["pendingWork"]),
            state,
            turn: decodeTurn(value["turn"]),
        };
    };

    readonly acceptConfiguration = async (
        scope: ProjectScope,
        runtimeId: string,
        command: SessionConfigureCommand,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionConfigurationAcceptance> => {
        const value = await this.request(
            scope,
            command.sessionId,
            "configure",
            { command: encodeSessionConfigureCommand(command), now, runtimeId },
            signal,
        );
        if (!isRecord(value) || value["status"] !== "accepted") {
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The Session configuration acceptance is invalid",
            );
        }
        return new SessionConfigurationAcceptance(
            readString(value, "requestId"),
            readBoolean(value, "duplicate"),
            decodePendingWork(value["pendingWork"]),
        );
    };

    readonly acceptTurnCancellation = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        turnId: string,
        idempotencyKey: string,
        now: number,
        signal: AbortSignal,
    ): Promise<TurnCancellationAcceptance> => {
        const value = await this.request(
            scope,
            sessionId,
            "cancel-turn",
            { idempotencyKey, now, runtimeId, sessionId, turnId },
            signal,
        );
        if (!isRecord(value) || typeof value["duplicate"] !== "boolean") {
            throw new SessionRuntimeError("session_storage_unavailable", "The Turn cancellation acceptance is invalid");
        }
        return {
            duplicate: value["duplicate"],
            pendingWork: decodePendingWork(value["pendingWork"]),
            turn: decodeTurn(value["turn"]),
        };
    };

    readonly promoteQueuedTurnToSteering = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        turnId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<Turn> =>
        decodeTurn(
            await this.request(
                scope,
                sessionId,
                "promote-turn-to-steering",
                { now, runtimeId, sessionId, turnId },
                signal,
            ),
        );

    readonly commitEvent = async (
        scope: ProjectScope,
        runtimeId: string,
        envelope: SessionEventEnvelope,
        now: number,
        signal: AbortSignal,
    ): Promise<CommittedEventResult> => {
        const value = await this.request(
            scope,
            envelope.sessionId,
            "commit",
            { envelope: encodeSessionEventEnvelope(envelope), now, runtimeId },
            signal,
        );
        if (!isRecord(value) || typeof value["duplicate"] !== "boolean") {
            throw new SessionRuntimeError("session_storage_unavailable", "The committed event result is invalid");
        }
        const committed = decodeCommittedSessionEvent(JSON.stringify(value["committed"]));
        const summary = value["summary"];
        if (summary !== undefined) {
            await this.updateDirectory(decodeSessionSummary(summary), signal);
        }
        return { committed, duplicate: value["duplicate"] };
    };

    readonly setDefaultBinding = async (
        scope: ProjectScope,
        sessionId: string,
        binding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        const summary = decodeSessionSummary(
            await this.request(scope, sessionId, "set-binding", { binding, now, sessionId }, signal),
        );
        await this.updateDirectory(summary, signal);
        return summary;
    };

    readonly acceptInteractionResponse = async (
        scope: ProjectScope,
        sessionId: string,
        interactionId: string,
        responderId: string,
        response: InteractionResponse,
        deliveryPayload: string,
        now: number,
        signal: AbortSignal,
    ): Promise<InteractionResponseAcceptance> => {
        const value = await this.request(
            scope,
            sessionId,
            "accept-interaction-response",
            {
                deliveryPayload,
                interactionId,
                now,
                responderId,
                response: decodeInteractionResponse(response),
                sessionId,
            },
            signal,
        );
        if (!isRecord(value) || typeof value["duplicate"] !== "boolean") {
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The Interaction response acceptance is invalid",
            );
        }
        return {
            duplicate: value["duplicate"],
            interaction: decodeInteraction(value["interaction"]),
            pendingWork: decodePendingWork(value["pendingWork"]),
        };
    };

    readonly readSession = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        const existing = await this.readDirectorySummary(scope, sessionId, signal);
        if (existing !== null) {
            return { ...existing, hasNativeHistory: true };
        }
        const summary = decodeSessionSummary(await this.request(scope, sessionId, "read", { sessionId }, signal));
        await this.updateDirectory(summary, signal);
        return summary;
    };

    readonly readConfiguration = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionConfigurationSnapshot> =>
        decodeConfiguration(await this.request(scope, sessionId, "configuration", { sessionId }, signal));

    readonly openEventStream = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        signal: AbortSignal,
    ): Promise<Response> => {
        signal.throwIfAborted();
        try {
            const existing = await this.readDirectorySummary(scope, sessionId, signal);
            if (existing === null) {
                throw new SessionRuntimeError("session_not_found", "The Session does not exist");
            }
            const response = await this.#transport.fetch(
                { runtimeId: existing.runtimeId, scope, sessionId },
                new Request("https://session.internal/internal/sessions/event-stream", {
                    body: JSON.stringify({ cursor, scope: infrastructureScope(scope), sessionId }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal,
                }),
            );
            signal.throwIfAborted();
            return response;
        } catch (cause) {
            if (signal.aborted) {
                throw cause;
            }
            throw new SessionRuntimeError("session_storage_unavailable", "The Session event stream is unavailable", {
                cause,
            });
        }
    };

    readonly readNativeHistory = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<NativeSessionHistory | null> => {
        const value = await this.request(scope, sessionId, "native-history", { sessionId }, signal);
        return value === null ? null : decodeNativeSessionHistory(value);
    };

    readonly queryNativeMessages = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<NativeMessagePage> =>
        decodeNativeMessagePage(
            await this.request(scope, sessionId, "query-native-messages", { cursor, limit, sessionId }, signal),
        );

    readonly recordNativeHistory = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        title: string,
        history: NativeSessionHistory,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        const summary = decodeSessionSummary(
            await this.request(
                scope,
                sessionId,
                "record-native-history",
                {
                    history: decodeNativeSessionHistory(history),
                    now,
                    runtimeId,
                    sessionId,
                    title,
                },
                signal,
            ),
        );
        await this.updateDirectory(summary, signal);
        return summary;
    };

    readonly readTurn = async (
        scope: ProjectScope,
        sessionId: string,
        turnId: string,
        signal: AbortSignal,
    ): Promise<Turn> => decodeTurn(await this.request(scope, sessionId, "turn", { sessionId, turnId }, signal));

    readonly readTurnRuntime = async (
        scope: ProjectScope,
        sessionId: string,
        turnId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        const value = await this.request(scope, sessionId, "turn-runtime", { sessionId, turnId }, signal);
        if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
            throw new SessionRuntimeError("session_storage_unavailable", "The Turn Runtime identity is invalid");
        }
        return value;
    };

    readonly readCommandRuntime = async (
        scope: ProjectScope,
        sessionId: string,
        commandId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        const value = await this.request(scope, sessionId, "command-runtime", { commandId, sessionId }, signal);
        if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
            throw new SessionRuntimeError("session_storage_unavailable", "The Turn Runtime identity is invalid");
        }
        return value;
    };

    readonly readAttempt = async (
        scope: ProjectScope,
        sessionId: string,
        attemptId: string,
        signal: AbortSignal,
    ): Promise<Attempt> =>
        decodeAttemptResource(await this.request(scope, sessionId, "attempt", { attemptId, sessionId }, signal));

    readonly readInteraction = async (
        scope: ProjectScope,
        sessionId: string,
        interactionId: string,
        signal: AbortSignal,
    ): Promise<Interaction> =>
        decodeInteraction(await this.request(scope, sessionId, "interaction", { interactionId, sessionId }, signal));

    readonly readInteractionRuntime = async (
        scope: ProjectScope,
        sessionId: string,
        interactionId: string,
        signal: AbortSignal,
    ): Promise<string> => {
        const value = await this.request(scope, sessionId, "interaction-runtime", { interactionId, sessionId }, signal);
        if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
            throw new SessionRuntimeError("session_storage_unavailable", "The Interaction Runtime identity is invalid");
        }
        return value;
    };

    readonly readPendingInteractions = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<readonly Interaction[]> => {
        const value = await this.request(scope, sessionId, "pending-interactions", { sessionId }, signal);
        if (!Array.isArray(value)) {
            throw new SessionRuntimeError("session_storage_unavailable", "The pending Interaction list is invalid");
        }
        return value.map(decodeInteraction);
    };

    readonly listPendingDaemonDeliveries = async (
        scope: ProjectScope,
        runtimeId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly PendingDaemonDelivery[]> => {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            throw new SessionRuntimeError("invalid_page_size", "The page size must be between 1 and 100");
        }
        const project = await this.#projects.resolve(scope.projectId, signal);
        const rows = await this.#directory.listReady(project, scope, signal);
        // Probe every ready Session under bounded concurrency and re-sort by directory index afterwards, so
        // the returned order stays the directory order regardless of which probe resolves first.
        const probes: { readonly index: number; readonly deliveries: readonly PendingDaemonDelivery[] }[] = [];
        const cancellation = new AbortController();
        const probeSignal = AbortSignal.any([signal, cancellation.signal]);
        let next = 0;
        const probe = async (): Promise<void> => {
            for (;;) {
                const index = next;
                next += 1;
                const row = rows[index];
                if (row === undefined) {
                    return;
                }
                probes.push({
                    deliveries: await this.probePendingDaemonDeliveries(
                        scope,
                        row.session_id,
                        runtimeId,
                        limit,
                        probeSignal,
                    ),
                    index,
                });
            }
        };
        try {
            await Promise.all(Array.from({ length: Math.min(SESSION_PROBE_CONCURRENCY, rows.length) }, probe));
        } catch (error) {
            cancellation.abort(error);
            throw error;
        }
        const deliveries: PendingDaemonDelivery[] = [];
        for (const { deliveries: pending } of probes.sort((left, right) => left.index - right.index)) {
            for (const delivery of pending) {
                deliveries.push(delivery);
                if (deliveries.length === limit) {
                    return deliveries;
                }
            }
        }
        return deliveries;
    };

    private readonly probePendingDaemonDeliveries = async (
        scope: ProjectScope,
        sessionId: string,
        runtimeId: string,
        limit: number,
        signal: AbortSignal,
    ): Promise<readonly PendingDaemonDelivery[]> => {
        const value = await this.request(scope, sessionId, "pending-daemon-deliveries", { limit, runtimeId }, signal);
        if (!Array.isArray(value)) {
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The pending Interaction response list is invalid",
            );
        }
        const deliveries: PendingDaemonDelivery[] = [];
        for (const entry of value) {
            if (
                !isRecord(entry) ||
                (entry["interactionId"] !== null && typeof entry["interactionId"] !== "string") ||
                typeof entry["payload"] !== "string"
            ) {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "A pending Interaction response is invalid",
                );
            }
            deliveries.push({
                interactionId: entry["interactionId"],
                payload: entry["payload"],
                pendingWork: decodePendingWork(entry["pendingWork"]),
            });
        }
        return deliveries;
    };

    readonly markPendingWorkCompleted = async (
        scope: ProjectScope,
        sessionId: string,
        workId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<PendingWork> =>
        decodePendingWork(
            await this.request(scope, sessionId, "complete-pending-work", { now, sessionId, workId }, signal),
        );

    readonly reconcileAttempt = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        attemptId: string,
        outcome: AttemptReconciliationOutcome,
        now: number,
        signal: AbortSignal,
    ): Promise<Attempt> =>
        decodeAttemptResource(
            await this.request(
                scope,
                sessionId,
                "reconcile",
                { attemptId, now, outcome, runtimeId, sessionId },
                signal,
            ),
        );

    readonly listSessions = async (
        scope: ProjectScope,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<SessionDirectoryPage> => {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            throw new SessionRuntimeError("invalid_page_size", "The page size must be between 1 and 100");
        }
        const decoded = cursor === null ? null : decodeDirectoryCursor(cursor, scope);
        const project = await this.#projects.resolve(scope.projectId, signal);
        const rows = await this.#directory.list(project, scope, decoded, limit + 1, signal);
        signal.throwIfAborted();
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
            nextCursor:
                rows.length > limit && last !== undefined
                    ? encodeDirectoryCursor(scope, last.updated_at, last.session_id)
                    : null,
            sessions: pageRows.map((row) => {
                let value: unknown;
                try {
                    value = JSON.parse(row.summary_json);
                } catch (cause) {
                    throw new SessionRuntimeError(
                        "session_storage_unavailable",
                        "The D1 session directory is invalid",
                        { cause },
                    );
                }
                return { ...decodeSessionSummary(value), hasNativeHistory: true };
            }),
        };
    };

    readonly readMessages = async (
        scope: ProjectScope,
        sessionId: string,
        _cursor: string | null,
        _limit: number,
        signal: AbortSignal,
        _timing: OperationTiming = unmeasuredOperationTiming,
    ): Promise<SessionMessagePage> => {
        const summary = await this.readDirectorySummary(scope, sessionId, signal);
        if (summary === null) {
            throw new SessionRuntimeError("session_not_found", "The Session does not exist");
        }
        throw new SessionRuntimeError(
            "session_history_not_retained",
            "This Session does not retain Platform message history",
        );
    };

    readonly readEvents = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<SessionEventPage> =>
        decodeEvents(await this.request(scope, sessionId, "events", { cursor, limit, sessionId }, signal));

    readonly waitForEvents = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        limit: number,
        waitMilliseconds: number,
        signal: AbortSignal,
    ): Promise<SessionEventPage> =>
        decodeEvents(
            await this.request(scope, sessionId, "wait-events", { cursor, limit, sessionId, waitMilliseconds }, signal),
        );

    readonly readToolCallDetail = async (
        scope: ProjectScope,
        sessionId: string,
        attemptId: string,
        toolCallId: string,
        signal: AbortSignal,
    ): Promise<ActivityDetail> =>
        decodeDetail(await this.request(scope, sessionId, "detail", { attemptId, sessionId, toolCallId }, signal));

    readonly exportSession = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionExport> => {
        signal.throwIfAborted();
        const summary = await this.readDirectorySummary(scope, sessionId, signal);
        if (summary === null) {
            throw new SessionRuntimeError("session_not_found", "The Session does not exist");
        }
        throw new SessionRuntimeError("session_history_not_retained", "This Session has no cloud export");
    };

    readonly importSession = async (
        _scope: ProjectScope,
        _exported: unknown,
        _targetBinding: CreateSessionBindingRequest,
        _now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        signal.throwIfAborted();
        throw new SessionRuntimeError("session_history_not_retained", "Cloud Session import is unavailable");
    };

    readonly deleteSession = async (
        scope: ProjectScope,
        sessionId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionLifecycle> => {
        const previous =
            (await this.readDirectorySummary(scope, sessionId, signal)) ??
            (await this.readSession(scope, sessionId, signal));
        const value = await this.request(scope, sessionId, "delete", { now, sessionId }, signal);
        const lifecycle = decodeLifecycle(value);
        if (lifecycle.kind === "deleted") {
            await this.releaseSession(scope, sessionId, signal);
        }
        await this.updateDirectory(
            {
                ...previous,
                lifecycle,
                updatedAt: new Date(now).toISOString(),
            },
            signal,
        );
        return lifecycle;
    };

    readonly markRuntimeDisconnected = async (
        scope: ProjectScope,
        runtimeId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<readonly ReturnType<typeof decodeCommittedSessionEvent>[]> => {
        const sessionIds = await this.listRuntimeSessionIds(scope, runtimeId, signal);
        for (const sessionId of sessionIds) {
            await this.disconnectSession(scope, runtimeId, sessionId, now, signal);
        }
        return [];
    };

    readonly listRuntimeSessionIds = async (
        scope: ProjectScope,
        runtimeId: string,
        signal: AbortSignal,
    ): Promise<readonly string[]> => {
        signal.throwIfAborted();
        const project = await this.#projects.resolve(scope.projectId, signal);
        const rows = await this.#directory.listRuntime(project, scope, runtimeId, signal);
        return rows.map((row) => row.session_id);
    };

    readonly disconnectSessions = async (
        _scope: ProjectScope,
        _runtimeId: string,
        sessions: readonly RuntimeDisconnectTarget[],
        _now: number,
        signal: AbortSignal,
        onDisconnected: (session: RuntimeDisconnectTarget) => void,
    ): Promise<void> => {
        for (const session of sessions) {
            signal.throwIfAborted();
            onDisconnected(session);
        }
    };

    readonly disconnectSession = async (
        _scope: ProjectScope,
        _runtimeId: string,
        _sessionId: string,
        _now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
    };

    private readonly request = async (
        scope: ProjectScope,
        sessionId: string,
        operation: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
        timing: OperationTiming = unmeasuredOperationTiming,
    ): Promise<unknown> => {
        signal.throwIfAborted();
        const existing = await this.readDirectorySummary(scope, sessionId, signal);
        if (existing === null) {
            throw new SessionRuntimeError("session_not_found", "The Session does not exist");
        }
        return await this.requestTarget(scope, existing.runtimeId, sessionId, operation, body, signal, timing);
    };

    private readonly requestCreating = async (
        scope: ProjectScope,
        sessionId: string,
        operation: string,
        body: Readonly<Record<string, unknown>>,
        runtimeId: string,
        signal: AbortSignal,
    ): Promise<unknown> => await this.requestTarget(scope, runtimeId, sessionId, operation, body, signal);

    private readonly requestTarget = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        operation: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
        timing: OperationTiming = unmeasuredOperationTiming,
    ): Promise<unknown> => {
        signal.throwIfAborted();
        const timeout = AbortSignal.timeout(SESSION_OPERATION_TIMEOUT_MILLISECONDS);
        const operationSignal = AbortSignal.any([signal, timeout]);
        let response: Response;
        try {
            response = await timing.measure(
                `${operation}-transport`,
                `Runtime relay ${operation} round trip`,
                async () =>
                    await this.#transport.fetch(
                        { runtimeId, scope, sessionId },
                        new Request(`https://session.internal/internal/sessions/${operation}`, {
                            body: JSON.stringify({ ...body, scope: infrastructureScope(scope) }),
                            headers: { "content-type": "application/json" },
                            method: "POST",
                            signal: operationSignal,
                        }),
                    ),
            );
        } catch (cause) {
            if (signal.aborted) {
                throw cause;
            }
            throw new SessionRuntimeError(
                timeout.aborted ? "session_storage_timeout" : "session_storage_unavailable",
                timeout.aborted ? "The session storage operation timed out" : "The Runtime relay is unavailable",
                { cause },
            );
        }
        operationSignal.throwIfAborted();
        // The Durable Object reports its own stages. Re-emit them prefixed so a reader can tell which side a
        // segment belongs to, and so they never collide with the Worker's names.
        for (const segment of decodeOperationTiming(response.headers.get(DO_TIMING_HEADER))) {
            timing.record(
                `${DO_TIMING_NAME_PREFIX}${segment.name}`,
                `Runtime relay ${segment.description}`,
                segment.durationMilliseconds,
            );
        }
        // `fetch` resolves once the Durable Object returns its headers, so reading and decoding the body is a
        // separate cost that only shows up here. The read and the parse are split because they scale differently:
        // the read tracks the transferred size, the parse tracks the object graph.
        const bytes = await timing.measure(
            `${operation}-body`,
            `Runtime relay ${operation} response body transfer`,
            async () => await readResponseBytes(response),
        );
        return await timing.measure(
            `${operation}-decode`,
            `Runtime relay ${operation} response decoding`,
            async () => await decodeResponseBytes(response, bytes),
        );
    };

    private readonly reserveSession = async (
        scope: ProjectScope,
        sessionId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionReservation> => {
        signal.throwIfAborted();
        try {
            const project = await this.#projects.resolve(scope.projectId, signal);
            const quota = await this.#quotaPolicy.resolveSessionQuota(scope, signal);
            const { changes, reservation } = await this.#directory.reserve(
                project,
                scope,
                sessionId,
                now,
                quota,
                signal,
            );
            signal.throwIfAborted();
            if (reservation === null) {
                await this.#quotaPolicy.recordSessionQuotaDenial(scope, sessionId, quota, signal);
                throw new SessionRuntimeError(
                    "session_quota_exceeded",
                    "The project active session quota is exhausted",
                );
            }
            return changes === 1 ? { kind: "reserved" } : { kind: "existing" };
        } catch (cause) {
            if (signal.aborted || cause instanceof SessionRuntimeError) {
                throw cause;
            }
            throw new SessionRuntimeError("session_storage_unavailable", "The session quota could not be reserved", {
                cause,
            });
        }
    };

    private readonly releaseSession = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        try {
            const project = await this.#projects.resolve(scope.projectId, signal);
            await this.#directory.release(project, scope, sessionId, signal);
            signal.throwIfAborted();
        } catch (cause) {
            if (signal.aborted) {
                throw cause;
            }
            throw new SessionRuntimeError("session_storage_unavailable", "The session quota could not be released", {
                cause,
            });
        }
    };

    private readonly readDirectorySummary = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionSummary | null> => {
        signal.throwIfAborted();
        const project = await this.#projects.resolve(scope.projectId, signal);
        const row = await this.#directory.read(project, scope, sessionId, signal);
        signal.throwIfAborted();
        if (row === null) {
            return null;
        }
        try {
            return decodeSessionSummary(JSON.parse(row.summary_json));
        } catch (cause) {
            throw new SessionRuntimeError("session_storage_unavailable", "The D1 session directory is invalid", {
                cause,
            });
        }
    };

    private readonly refreshDirectory = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<void> => {
        try {
            const value = await this.request(scope, sessionId, "read", { sessionId }, signal);
            await this.updateDirectory(decodeSessionSummary(value), signal);
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            console.error("D1 session directory refresh failed", error);
        }
    };

    readonly synchronizeSession = async (summary: SessionSummary, signal: AbortSignal): Promise<void> => {
        try {
            const project = await this.#projects.resolve(summary.projectId, signal);
            await this.#directory.update(project, summary, signal);
        } catch (cause) {
            signal.throwIfAborted();
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The D1 session directory could not be updated",
                { cause },
            );
        }
    };

    private readonly updateDirectory = this.synchronizeSession;
}
