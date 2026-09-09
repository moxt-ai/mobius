import {
    type Attempt,
    decodeAgentActivityEvent,
    decodeAttempt as decodeAttemptResource,
    decodeCommandReceipt,
    decodeCommittedSessionEvent,
    decodeInteraction,
    decodeInteractionResponse,
    decodeNativeSessionHistory,
    decodePendingWork,
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeSessionBinding,
    decodeSessionPromptCommand,
    decodeTurn,
    encodeSessionEventEnvelope,
    encodeSessionPromptCommand,
    type Interaction,
    type InteractionResponse,
    type NativeSessionHistory,
    type PendingWork,
    type SessionEventEnvelope,
    type SessionPromptCommand,
    type Turn,
} from "@moxt-ai/mobius-protocol";
import {
    type ActivityDetail,
    ArtifactContent,
    type ArtifactDescriptor,
    ArtifactUploadAuthorization,
    ArtifactUploadLease,
    type AttemptReconciliationOutcome,
    AvailableArtifactDescriptor,
    type CommittedEventResult,
    type CreateArtifactUploadRequest,
    type CreateSessionBindingRequest,
    type CreateSessionRequest,
    ExpiredArtifactDescriptor,
    type InteractionResponseAcceptance,
    type PendingDaemonDelivery,
    type ProjectScope,
    type SessionDirectoryPage,
    type SessionEventPage,
    type SessionExport,
    type SessionLifecycle,
    type SessionMessage,
    type SessionMessagePage,
    type SessionQuotaPolicy,
    SessionRuntimeError,
    type SessionSummary,
    type TurnAcceptance,
    type TurnCancellationAcceptance,
    UploadingArtifactDescriptor,
} from "../../entity/do/session.ts";
import type {
    SessionArtifactGateway,
    SessionCommandGateway,
    SessionEventStreamGateway,
    SessionQueryGateway,
    SessionTransferGateway,
} from "../../gateway/index.ts";
import type { SessionTransport } from "../../gateway/session-transport.ts";
import type { DatabaseResolver } from "../../infra/database-resolver.ts";
import type { TenantShardingDirectory } from "../../infra/tenant-sharding-directory.ts";
import type { SessionDirectoryStorage } from "../../storage/session-directory-storage.ts";
import { validateCreateSessionRequest } from "./session-records.ts";

const SESSION_OPERATION_TIMEOUT_MILLISECONDS = 20_000;

const MAX_INTERNAL_RESPONSE_LENGTH = 96 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DIRECTORY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;
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
        if (
            typeof identifier !== "string" ||
            !DIRECTORY_IDENTIFIER_PATTERN.test(identifier) ||
            unique.has(identifier)
        ) {
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

function decodeSummary(value: unknown): SessionSummary {
    if (!isRecord(value) || !isRecord(value["policy"]) || !isRecord(value["defaultBinding"])) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session summary is invalid");
    }
    const policy = value["policy"];
    const defaultBinding = value["defaultBinding"];
    const level = policy["level"];
    if (level !== "full" && level !== "summary") {
        throw new SessionRuntimeError("session_storage_unavailable", "The session policy is invalid");
    }
    return {
        agentId: readString(value, "agentId"),
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
        tenantId: readString(value, "tenantId"),
        title: readString(value, "title", true),
        updatedAt: readString(value, "updatedAt"),
    };
}

function decodeAttempt(value: unknown): SessionMessage["attempt"] {
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

function decodeMessage(value: unknown): SessionMessage {
    if (!isRecord(value) || !Array.isArray(value["activities"])) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session message is invalid");
    }
    const activities = value["activities"].map((activity) => {
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
    return {
        activities,
        additionalDirectoryIds: readDirectoryIdentifiers(value, "additionalDirectoryIds"),
        agentId: readString(value, "agentId"),
        attempt: decodeAttempt(value["attempt"]),
        commandId: readString(value, "commandId"),
        createdAt: readString(value, "createdAt"),
        images: decodePromptImagesValue(value["images"]),
        prompt: readString(value, "prompt", true),
        resources: decodePromptResourcesValue(value["resources"]),
        response: readString(value, "response", true),
        sessionId: readString(value, "sessionId"),
    };
}

function decodeMessages(value: unknown): SessionMessagePage {
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

function decodeUploadingArtifact(value: unknown): UploadingArtifactDescriptor {
    if (!isRecord(value) || value["state"] !== "uploading") {
        throw new SessionRuntimeError("session_storage_unavailable", "The artifact upload descriptor is invalid");
    }
    return new UploadingArtifactDescriptor(
        readString(value, "sessionId"),
        readString(value, "artifactId"),
        readString(value, "name"),
        readString(value, "mediaType"),
        readNumber(value, "byteLength"),
        readString(value, "sha256"),
        readString(value, "createdAt"),
        readString(value, "expiresAt"),
    );
}

function decodeAvailableArtifact(value: unknown): AvailableArtifactDescriptor {
    if (!isRecord(value) || value["state"] !== "available") {
        throw new SessionRuntimeError("session_storage_unavailable", "The available artifact descriptor is invalid");
    }
    return new AvailableArtifactDescriptor(
        readString(value, "sessionId"),
        readString(value, "artifactId"),
        readString(value, "name"),
        readString(value, "mediaType"),
        readNumber(value, "byteLength"),
        readString(value, "sha256"),
        readString(value, "createdAt"),
        readString(value, "availableAt"),
    );
}

function decodeArtifact(value: unknown): ArtifactDescriptor {
    if (!isRecord(value)) {
        throw new SessionRuntimeError("session_storage_unavailable", "The artifact descriptor is invalid");
    }
    if (value["state"] === "uploading") {
        return decodeUploadingArtifact(value);
    }
    if (value["state"] === "available") {
        return decodeAvailableArtifact(value);
    }
    if (value["state"] === "expired") {
        return new ExpiredArtifactDescriptor(
            readString(value, "sessionId"),
            readString(value, "artifactId"),
            readString(value, "name"),
            readString(value, "mediaType"),
            readNumber(value, "byteLength"),
            readString(value, "sha256"),
            readString(value, "createdAt"),
            readString(value, "expiredAt"),
        );
    }
    throw new SessionRuntimeError("session_storage_unavailable", "The artifact state is invalid");
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
    let binary: string;
    try {
        binary = atob(value);
    } catch (cause) {
        throw new SessionRuntimeError("session_storage_unavailable", "The artifact content encoding is invalid", {
            cause,
        });
    }
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeExport(value: unknown): SessionExport {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, [
            "artifacts",
            "bindings",
            "commandReceipts",
            "events",
            "interactions",
            "minimumSequence",
            "nativeHistory",
            "nextSequence",
            "session",
            "toolCallViews",
            "turns",
            "uploadedArtifacts",
        ]) ||
        !Array.isArray(value["toolCallViews"]) ||
        !Array.isArray(value["artifacts"]) ||
        !Array.isArray(value["uploadedArtifacts"]) ||
        !Array.isArray(value["bindings"]) ||
        !Array.isArray(value["commandReceipts"]) ||
        !Array.isArray(value["interactions"]) ||
        !Array.isArray(value["turns"]) ||
        !Array.isArray(value["events"])
    ) {
        throw new SessionRuntimeError("session_storage_unavailable", "The session export is invalid");
    }
    const artifacts = value["artifacts"].map((artifact) => {
        if (!isRecord(artifact) || artifact["contentEncoding"] !== "identity") {
            throw new SessionRuntimeError("session_storage_unavailable", "The exported artifact is invalid");
        }
        const contentEncoding: "identity" = "identity";
        return {
            attemptId: readString(artifact, "attemptId"),
            artifactId: readString(artifact, "artifactId"),
            byteLength: readNumber(artifact, "byteLength"),
            contentBase64: readString(artifact, "contentBase64", true),
            contentEncoding,
            mediaType: readString(artifact, "mediaType"),
            sha256: readString(artifact, "sha256"),
            toolCallId: readString(artifact, "toolCallId"),
        };
    });
    const uploadedArtifacts = value["uploadedArtifacts"].map((artifact) => {
        if (!isRecord(artifact) || artifact["contentEncoding"] !== "identity") {
            throw new SessionRuntimeError("session_storage_unavailable", "The uploaded export artifact is invalid");
        }
        const contentEncoding: "identity" = "identity";
        return {
            artifactId: readString(artifact, "artifactId"),
            availableAt: readString(artifact, "availableAt"),
            byteLength: readNumber(artifact, "byteLength"),
            contentBase64: readString(artifact, "contentBase64", true),
            contentEncoding,
            createdAt: readString(artifact, "createdAt"),
            mediaType: readString(artifact, "mediaType"),
            name: readString(artifact, "name"),
            sha256: readString(artifact, "sha256"),
        };
    });
    return {
        artifacts,
        bindings: value["bindings"].map(decodeSessionBinding),
        commandReceipts: value["commandReceipts"].map(decodeCommandReceipt),
        events: value["events"].map((event) => decodeCommittedSessionEvent(JSON.stringify(event))),
        interactions: value["interactions"].map(decodeInteraction),
        minimumSequence: readString(value, "minimumSequence"),
        nativeHistory: value["nativeHistory"] === null ? null : decodeNativeSessionHistory(value["nativeHistory"]),
        nextSequence: readString(value, "nextSequence"),
        session: decodeSummary(value["session"]),
        toolCallViews: value["toolCallViews"].map((activity) => {
            if (!isRecord(activity)) {
                throw new SessionRuntimeError("session_storage_unavailable", "The exported activity is invalid");
            }
            return {
                attemptId: readString(activity, "attemptId"),
                event: decodeAgentActivityEvent(JSON.stringify(activity["event"])),
                eventSequence: readString(activity, "eventSequence"),
            };
        }),
        turns: value["turns"].map((command) => {
            if (!isRecord(command) || !isRecord(command["state"])) {
                throw new SessionRuntimeError("session_storage_unavailable", "The exported command is invalid");
            }
            const state = command["state"];
            return {
                command: decodeSessionPromptCommand(JSON.stringify(command["command"])),
                createdAt: readString(command, "createdAt"),
                response: readString(command, "response", true),
                state: state["kind"] === "queued" ? { kind: "queued" } : (decodeAttempt(state) ?? { kind: "queued" }),
                turn: decodeTurn(command["turn"]),
                updatedAt: readString(command, "updatedAt"),
            };
        }),
        uploadedArtifacts,
    };
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
        case "session_not_found":
        case "session_quota_exceeded":
        case "session_storage_timeout":
        case "session_storage_unavailable":
            return value;
        default:
            return "session_storage_unavailable";
    }
}

async function responseJson(response: Response): Promise<unknown> {
    const encoded = await response.text();
    if (encoded.length === 0 || encoded.length > MAX_INTERNAL_RESPONSE_LENGTH) {
        throw new SessionRuntimeError(
            "session_storage_unavailable",
            "The Session Durable Object returned an invalid response",
        );
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new SessionRuntimeError(
            "session_storage_unavailable",
            "The Session Durable Object returned invalid JSON",
            { cause },
        );
    }
    if (!response.ok) {
        if (isRecord(value) && isRecord(value["error"])) {
            const code = value["error"]["code"];
            const message = value["error"]["message"];
            if (typeof code === "string" && typeof message === "string") {
                throw new SessionRuntimeError(runtimeErrorCode(code), message);
            }
        }
        throw new SessionRuntimeError(
            "session_storage_unavailable",
            "The Session Durable Object rejected the operation",
        );
    }
    return value;
}

function encodeDirectoryCursor(scope: ProjectScope, updatedAt: number, sessionId: string): string {
    return btoa(
        JSON.stringify({
            projectId: scope.projectId,
            sessionId,
            tenantId: scope.tenantId,
            updatedAt,
        }),
    )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
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
            !hasExactKeys(value, ["projectId", "sessionId", "tenantId", "updatedAt"]) ||
            value["tenantId"] !== scope["tenantId"] ||
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
    implements
        SessionCommandGateway,
        SessionQueryGateway,
        SessionTransferGateway,
        SessionArtifactGateway,
        SessionEventStreamGateway
{
    readonly #directory: SessionDirectoryStorage;
    readonly #tenants: TenantShardingDirectory;
    readonly #transport: SessionTransport;
    readonly #quota: SessionQuotaPolicy;

    constructor(cx: {
        readonly storages: { readonly directory: SessionDirectoryStorage };
        readonly gateways: {
            readonly transport: SessionTransport;
            readonly databaseResolver: DatabaseResolver;
            readonly tenantShardingDirectory: TenantShardingDirectory;
        };
        readonly config: { readonly quota: SessionQuotaPolicy };
    }) {
        this.#directory = cx.storages.directory;
        this.#tenants = cx.gateways.tenantShardingDirectory;
        this.#transport = cx.gateways.transport;
        this.#quota = cx.config.quota;
    }

    readonly createSession = async (
        scope: ProjectScope,
        request: CreateSessionRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        validateCreateSessionRequest(request);
        await this.reserveSession(scope, request.sessionId, now, signal);
        const summary = decodeSummary(await this.request(scope, request.sessionId, "create", { now, request }, signal));
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

    readonly createArtifactUpload = async (
        scope: ProjectScope,
        sessionId: string,
        request: CreateArtifactUploadRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<ArtifactUploadAuthorization> => {
        const value = await this.request(
            scope,
            sessionId,
            "artifact-create-upload",
            { now, request, sessionId },
            signal,
        );
        if (!isRecord(value)) {
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The artifact upload authorization is invalid",
            );
        }
        return new ArtifactUploadAuthorization(decodeUploadingArtifact(value), readString(value, "uploadToken"));
    };

    readonly authorizeArtifactUpload = async (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        uploadToken: string,
        now: number,
        signal: AbortSignal,
    ): Promise<ArtifactUploadLease> => {
        const value = await this.request(
            scope,
            sessionId,
            "artifact-authorize-upload",
            { artifactId, now, sessionId, uploadToken },
            signal,
        );
        if (!isRecord(value)) {
            throw new SessionRuntimeError("session_storage_unavailable", "The artifact upload lease is invalid");
        }
        return new ArtifactUploadLease(
            decodeUploadingArtifact(value["artifact"]),
            readString(value, "contentTargetId"),
        );
    };

    readonly completeArtifactUpload = async (
        scope: ProjectScope,
        lease: ArtifactUploadLease,
        bytes: Uint8Array,
        now: number,
        signal: AbortSignal,
    ): Promise<AvailableArtifactDescriptor> =>
        decodeAvailableArtifact(
            await this.request(
                scope,
                lease.artifact.sessionId,
                "artifact-complete-upload",
                { contentBase64: encodeBase64(bytes), lease, now },
                signal,
            ),
        );

    readonly readArtifact = async (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<ArtifactDescriptor> =>
        decodeArtifact(await this.request(scope, sessionId, "artifact-read", { artifactId, now, sessionId }, signal));

    readonly readArtifactContent = async (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        signal: AbortSignal,
    ): Promise<ArtifactContent> => {
        const value = await this.request(scope, sessionId, "artifact-content", { artifactId, sessionId }, signal);
        if (!isRecord(value)) {
            throw new SessionRuntimeError("session_storage_unavailable", "The artifact content response is invalid");
        }
        return new ArtifactContent(
            decodeAvailableArtifact(value["artifact"]),
            decodeBase64(readString(value, "contentBase64", true)),
        );
    };

    readonly resolveArtifactResources = async (
        scope: ProjectScope,
        sessionId: string,
        artifactIds: readonly string[],
        signal: AbortSignal,
    ): Promise<SessionPromptCommand["resources"]> =>
        decodePromptResourcesValue(
            await this.request(scope, sessionId, "artifact-resources", { artifactIds, sessionId }, signal),
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
        await this.updateDirectory(decodeSummary(value["summary"]), signal);
        return { committed, duplicate: value["duplicate"] };
    };

    readonly setDefaultBinding = async (
        scope: ProjectScope,
        sessionId: string,
        binding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        const summary = decodeSummary(
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
        const summary = decodeSummary(await this.request(scope, sessionId, "read", { sessionId }, signal));
        await this.updateDirectory(summary, signal);
        return summary;
    };

    readonly openEventStream = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string,
        signal: AbortSignal,
    ): Promise<Response> => {
        signal.throwIfAborted();
        try {
            const response = await this.#transport.fetch(
                scope,
                sessionId,
                new Request("https://session.internal/internal/sessions/event-stream", {
                    body: JSON.stringify({ cursor, scope, sessionId }),
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

    readonly recordNativeHistory = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        title: string,
        history: NativeSessionHistory,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        const summary = decodeSummary(
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
        const tenant = await this.#tenants.resolve(scope.tenantId, signal);
        const rows = await this.#directory.listReady(tenant, scope, signal);
        const deliveries: PendingDaemonDelivery[] = [];
        for (const row of rows) {
            signal.throwIfAborted();
            const value = await this.request(
                scope,
                row.session_id,
                "pending-daemon-deliveries",
                { limit: limit - deliveries.length, runtimeId },
                signal,
            );
            if (!Array.isArray(value)) {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The pending Interaction response list is invalid",
                );
            }
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
                if (deliveries.length === limit) {
                    return deliveries;
                }
            }
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
        const tenant = await this.#tenants.resolve(scope.tenantId, signal);
        const rows = await this.#directory.list(tenant, scope, decoded, limit + 1, signal);
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
                return decodeSummary(value);
            }),
        };
    };

    readonly readMessages = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<SessionMessagePage> =>
        decodeMessages(await this.request(scope, sessionId, "messages", { cursor, limit, sessionId }, signal));

    readonly readEvents = async (
        scope: ProjectScope,
        sessionId: string,
        cursor: string | null,
        limit: number,
        signal: AbortSignal,
    ): Promise<SessionEventPage> =>
        decodeEvents(await this.request(scope, sessionId, "events", { cursor, limit, sessionId }, signal));

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
    ): Promise<SessionExport> => decodeExport(await this.request(scope, sessionId, "export", { sessionId }, signal));

    readonly importSession = async (
        scope: ProjectScope,
        exported: unknown,
        targetBinding: CreateSessionBindingRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionSummary> => {
        if (!isRecord(exported) || !isRecord(exported["session"])) {
            throw new SessionRuntimeError("invalid_export", "The session export is invalid");
        }
        const sessionId = readString(exported["session"], "sessionId");
        if (!IDENTIFIER_PATTERN.test(sessionId)) {
            throw new SessionRuntimeError("invalid_export", "The exported session identifier is invalid");
        }
        const reservation = await this.reserveSession(scope, sessionId, now, signal);
        let summary: SessionSummary;
        try {
            summary = decodeSummary(
                await this.request(scope, sessionId, "import", { binding: targetBinding, exported, now }, signal),
            );
        } catch (error) {
            if (
                reservation.kind === "reserved" &&
                error instanceof SessionRuntimeError &&
                error.code === "invalid_export"
            ) {
                await this.releaseSession(scope, sessionId, signal);
            }
            throw error;
        }
        await this.updateDirectory(summary, signal);
        return summary;
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
        const tenant = await this.#tenants.resolve(scope.tenantId, signal);
        const rows = await this.#directory.listRuntime(tenant, scope, runtimeId, signal);
        return rows.map((row) => row.session_id);
    };

    readonly disconnectSession = async (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        try {
            await this.request(scope, sessionId, "disconnect", { now, runtimeId }, signal);
        } catch (error) {
            signal.throwIfAborted();
            if (
                error instanceof SessionRuntimeError &&
                (error.code === "session_deleted" || error.code === "session_not_found")
            ) {
                return;
            }
            throw error;
        }
    };

    private readonly request = async (
        scope: ProjectScope,
        sessionId: string,
        operation: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ): Promise<unknown> => {
        signal.throwIfAborted();
        const timeout = AbortSignal.timeout(SESSION_OPERATION_TIMEOUT_MILLISECONDS);
        const operationSignal = AbortSignal.any([signal, timeout]);
        let response: Response;
        try {
            response = await this.#transport.fetch(
                scope,
                sessionId,
                new Request(`https://session.internal/internal/sessions/${operation}`, {
                    body: JSON.stringify({ ...body, scope }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                    signal: operationSignal,
                }),
            );
        } catch (cause) {
            if (signal.aborted) {
                throw cause;
            }
            throw new SessionRuntimeError(
                timeout.aborted ? "session_storage_timeout" : "session_storage_unavailable",
                timeout.aborted
                    ? "The session storage operation timed out"
                    : "The Session Durable Object is unavailable",
                { cause },
            );
        }
        operationSignal.throwIfAborted();
        return await responseJson(response);
    };

    private readonly reserveSession = async (
        scope: ProjectScope,
        sessionId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<SessionReservation> => {
        signal.throwIfAborted();
        try {
            const tenant = await this.#tenants.resolve(scope.tenantId, signal);
            const { changes, reservation } = await this.#directory.reserve(
                tenant,
                scope,
                sessionId,
                now,
                this.#quota,
                signal,
            );
            signal.throwIfAborted();
            if (reservation === null) {
                throw new SessionRuntimeError(
                    "session_quota_exceeded",
                    "The tenant or project active session quota is exhausted",
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
            const tenant = await this.#tenants.resolve(scope.tenantId, signal);
            await this.#directory.release(tenant, scope, sessionId, signal);
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
        const tenant = await this.#tenants.resolve(scope.tenantId, signal);
        const row = await this.#directory.read(tenant, scope, sessionId, signal);
        signal.throwIfAborted();
        if (row === null) {
            return null;
        }
        try {
            return decodeSummary(JSON.parse(row.summary_json));
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
            await this.updateDirectory(decodeSummary(value), signal);
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            console.error("D1 session directory refresh failed", error);
        }
    };

    private readonly updateDirectory = async (summary: SessionSummary, signal: AbortSignal): Promise<void> => {
        try {
            const tenant = await this.#tenants.resolve(summary.tenantId, signal);
            await this.#directory.update(tenant, summary, signal);
        } catch (cause) {
            signal.throwIfAborted();
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The D1 session directory could not be updated",
                { cause },
            );
        }
    };
}
