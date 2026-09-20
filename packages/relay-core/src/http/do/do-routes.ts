import {
    decodeInteractionResponse,
    decodeNativeSessionHistory,
    decodeSessionConfigureCommand,
    decodeSessionEventEnvelope,
    decodeSessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";
import {
    ArtifactUploadLease,
    type AttemptReconciliationOutcome,
    CreateArtifactUploadRequest,
    CreateSessionBindingRequest,
    CreateSessionRequest,
    ProjectScope,
    SESSION_DIRECTORY_IDENTIFIER_MAX_LENGTH,
    SessionRecordingPolicy,
    UploadingArtifactDescriptor,
} from "../../entity/do/session.ts";
import { type HttpError, isHttpError } from "../../entity/http-error.ts";
import { RequestBodyError, readBoundedUtf8Body } from "../../infra/bounded-request-body.ts";
import { compressJsonBody } from "../../infra/compressed-json.ts";
import { DO_TIMING_HEADER, encodeDoTiming, type OperationTimingMetric } from "../../infra/operation-timing.ts";
import type { DoService } from "../../service/do/do-service.ts";
import type { SqliteSessionRuntime } from "../../service/do/sqlite-session-runtime.ts";

const MAX_INTERNAL_BODY_LENGTH = 96 * 1024 * 1024;

/**
 * Times one stage of an internal operation and appends it to `segments`, so the Durable Object can report a
 * breakdown instead of one opaque total that hides which stage the time went to.
 */
async function measureSegment<T>(
    segments: OperationTimingMetric[],
    name: string,
    description: string,
    operation: () => Promise<T>,
): Promise<T> {
    const startedAt = performance.now();
    try {
        return await operation();
    } finally {
        segments.push({ description, durationMilliseconds: Math.max(0, performance.now() - startedAt), name });
    }
}

class InternalRequestError extends Error implements HttpError {
    readonly code: string;
    readonly httpStatus: number;

    constructor(code: string, message: string, httpStatus = 400, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.httpStatus = httpStatus;
        this.name = "InternalRequestError";
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.httpStatus,
    });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
        throw new InternalRequestError("invalid_session_operation", "The session operation is invalid");
    }
}

function readString(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength = 128,
    allowEmpty = false,
): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximumLength || (!allowEmpty && field.length === 0)) {
        throw new InternalRequestError("invalid_session_operation", `The ${key} field is invalid`);
    }
    return field;
}

function readCreateArtifactUploadRequest(value: Readonly<Record<string, unknown>>): CreateArtifactUploadRequest {
    const request = value["request"];
    if (!isRecord(request)) {
        throw new InternalRequestError("invalid_session_operation", "The artifact upload request is invalid");
    }
    assertExactKeys(request, ["byteLength", "mediaType", "name", "sha256"]);
    return new CreateArtifactUploadRequest(
        readString(request, "name", 500),
        readString(request, "mediaType", 255),
        readInteger(request, "byteLength"),
        readString(request, "sha256", 64),
    );
}

function readArtifactUploadLease(value: Readonly<Record<string, unknown>>): ArtifactUploadLease {
    const lease = value["lease"];
    if (!isRecord(lease) || !isRecord(lease["artifact"])) {
        throw new InternalRequestError("invalid_session_operation", "The artifact upload lease is invalid");
    }
    const artifact = lease["artifact"];
    if (artifact["state"] !== "uploading") {
        throw new InternalRequestError("invalid_session_operation", "The artifact upload lease is invalid");
    }
    return new ArtifactUploadLease(
        new UploadingArtifactDescriptor(
            readString(artifact, "sessionId"),
            readString(artifact, "artifactId"),
            readString(artifact, "name", 500),
            readString(artifact, "mediaType", 255),
            readInteger(artifact, "byteLength"),
            readString(artifact, "sha256", 64),
            readString(artifact, "createdAt"),
            readString(artifact, "expiresAt"),
        ),
        readString(lease, "contentTargetId"),
    );
}

function decodeBase64(value: string): Uint8Array {
    let binary: string;
    try {
        binary = atob(value);
    } catch (cause) {
        throw new InternalRequestError("invalid_session_operation", "The artifact content is invalid", 400, { cause });
    }
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return btoa(binary);
}

function readInteger(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new InternalRequestError("invalid_session_operation", `The ${key} field is invalid`);
    }
    return field;
}

function readNullableString(value: Readonly<Record<string, unknown>>, key: string): string | null {
    const field = value[key];
    if (field === null) {
        return null;
    }
    if (typeof field !== "string") {
        throw new InternalRequestError("invalid_session_operation", `The ${key} field is invalid`);
    }
    return field;
}

function readScope(value: Readonly<Record<string, unknown>>): ProjectScope {
    const scope = value["scope"];
    if (!isRecord(scope)) {
        throw new InternalRequestError("invalid_session_operation", "The project scope is invalid");
    }
    assertExactKeys(scope, ["projectId"]);
    return new ProjectScope(readString(scope, "projectId"));
}

function readCreateRequest(value: Readonly<Record<string, unknown>>): CreateSessionRequest {
    const request = value["request"];
    if (!isRecord(request)) {
        throw new InternalRequestError("invalid_session_operation", "The session creation request is invalid");
    }
    assertExactKeys(request, [
        "agentId",
        "bindingId",
        "createdBy",
        "directoryId",
        "policy",
        "runtimeId",
        "sessionId",
        "title",
    ]);
    const policy = request["policy"];
    if (!isRecord(policy)) {
        throw new InternalRequestError("invalid_session_operation", "The session policy is invalid");
    }
    assertExactKeys(policy, [
        "contentLimitBytes",
        "hotEventLimit",
        "idempotencyRetentionMilliseconds",
        "level",
        "retentionMilliseconds",
    ]);
    const level = policy["level"];
    if (level !== "full" && level !== "summary") {
        throw new InternalRequestError("invalid_session_operation", "The session recording level is invalid");
    }
    return new CreateSessionRequest(
        readString(request, "sessionId"),
        readString(request, "runtimeId"),
        readString(request, "agentId"),
        readString(request, "bindingId"),
        readString(request, "directoryId", SESSION_DIRECTORY_IDENTIFIER_MAX_LENGTH),
        new SessionRecordingPolicy(
            level,
            readInteger(policy, "retentionMilliseconds"),
            readInteger(policy, "hotEventLimit"),
            readInteger(policy, "contentLimitBytes"),
            readInteger(policy, "idempotencyRetentionMilliseconds"),
        ),
        readString(request, "title", 500, true),
        readString(request, "createdBy"),
    );
}

function readBinding(value: Readonly<Record<string, unknown>>): CreateSessionBindingRequest {
    const binding = value["binding"];
    if (!isRecord(binding)) {
        throw new InternalRequestError("invalid_session_operation", "The Session binding is invalid");
    }
    assertExactKeys(binding, ["agentRef", "bindingId", "configRevision", "runtimeId", "workspaceRef"]);
    return new CreateSessionBindingRequest(
        readString(binding, "bindingId"),
        readString(binding, "runtimeId"),
        readString(binding, "agentRef"),
        readString(binding, "workspaceRef", SESSION_DIRECTORY_IDENTIFIER_MAX_LENGTH),
        readInteger(binding, "configRevision"),
    );
}

function readReconciliationOutcome(value: Readonly<Record<string, unknown>>): AttemptReconciliationOutcome {
    const outcome = value["outcome"];
    if (!isRecord(outcome)) {
        throw new InternalRequestError("invalid_session_operation", "The Attempt reconciliation outcome is invalid");
    }
    const kind = outcome["kind"];
    if (kind === "running") {
        assertExactKeys(outcome, ["kind"]);
        return { kind };
    }
    if (kind === "succeeded") {
        assertExactKeys(outcome, ["kind", "stopReason"]);
        return { kind, stopReason: readString(outcome, "stopReason") };
    }
    if (kind === "cancelled") {
        assertExactKeys(outcome, ["kind"]);
        return { kind };
    }
    if (kind === "failed" && isRecord(outcome["error"])) {
        assertExactKeys(outcome, ["error", "kind"]);
        const error = outcome["error"];
        assertExactKeys(error, ["code", "message", "retryable"]);
        if (typeof error["retryable"] !== "boolean") {
            throw new InternalRequestError("invalid_session_operation", "The Attempt reconciliation error is invalid");
        }
        return {
            error: {
                code: readString(error, "code"),
                message: readString(error, "message", 2_000),
                retryable: error["retryable"],
            },
            kind,
        };
    }
    throw new InternalRequestError("invalid_session_operation", "The Attempt reconciliation outcome is invalid");
}

async function readBody(request: Request): Promise<Readonly<Record<string, unknown>>> {
    let encoded: string;
    try {
        encoded = await readBoundedUtf8Body(request, MAX_INTERNAL_BODY_LENGTH);
    } catch (cause) {
        if (cause instanceof RequestBodyError) {
            throw new InternalRequestError(
                "invalid_session_operation",
                cause.code === "body_too_large"
                    ? "The session operation is too large"
                    : "The session operation is invalid",
                cause.code === "body_too_large" ? 413 : 400,
            );
        }
        throw cause;
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new InternalRequestError(
            "invalid_session_operation",
            cause instanceof Error ? "The session operation is invalid" : "Invalid JSON",
        );
    }
    if (!isRecord(value)) {
        throw new InternalRequestError("invalid_session_operation", "The session operation must be an object");
    }
    return value;
}

function operationFromPath(pathname: string): string {
    const segments = pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length !== 3 || segments[0] !== "internal" || segments[1] !== "sessions") {
        throw new InternalRequestError("session_not_found", "The session operation does not exist", 404);
    }
    return segments[2] ?? "";
}

function errorResponse(error: Error & HttpError): Response {
    const response = error.toHttpJson();
    return Response.json(response.body, { status: response.status, headers: response.headers ?? {} });
}

class DoRoutes {
    readonly #runtime: SqliteSessionRuntime;
    readonly #operations: DoService;

    constructor(runtime: SqliteSessionRuntime, operations: DoService) {
        this.#runtime = runtime;
        this.#operations = operations;
    }

    async fetch(request: Request): Promise<Response> {
        try {
            if (request.method !== "POST") {
                return new Response(null, { status: 405 });
            }
            const operation = operationFromPath(new URL(request.url).pathname);
            const body = await readBody(request);
            if (operation === "migrate-cloud-retention") {
                assertExactKeys(body, []);
                return new Response(null, { status: 204 });
            }
            const scope = readScope(body);
            if (operation === "event-stream") {
                assertExactKeys(body, ["cursor", "scope", "sessionId"]);
                return await this.#runtime.openEventStream(
                    scope,
                    readString(body, "sessionId"),
                    readString(body, "cursor", 512, true),
                    request.signal,
                );
            }
            if (operation === "create") {
                assertExactKeys(body, ["now", "request", "scope"]);
                return Response.json(
                    await this.#runtime.createSession(
                        scope,
                        readCreateRequest(body),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "accept") {
                assertExactKeys(body, ["command", "now", "runtimeId", "scope"]);
                return Response.json(
                    await this.#runtime.acceptTurn(
                        scope,
                        readString(body, "runtimeId"),
                        decodeSessionPromptCommand(readString(body, "command", 8_000_000)),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "configure") {
                assertExactKeys(body, ["command", "now", "runtimeId", "scope"]);
                return Response.json(
                    await this.#runtime.acceptConfiguration(
                        scope,
                        readString(body, "runtimeId"),
                        decodeSessionConfigureCommand(readString(body, "command", 8_000_000)),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "cancel-turn") {
                assertExactKeys(body, ["idempotencyKey", "now", "runtimeId", "scope", "sessionId", "turnId"]);
                return Response.json(
                    await this.#runtime.acceptTurnCancellation(
                        scope,
                        readString(body, "runtimeId"),
                        readString(body, "sessionId"),
                        readString(body, "turnId"),
                        readString(body, "idempotencyKey"),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "promote-turn-to-steering") {
                assertExactKeys(body, ["now", "runtimeId", "scope", "sessionId", "turnId"]);
                return Response.json(
                    await this.#runtime.promoteQueuedTurnToSteering(
                        scope,
                        readString(body, "runtimeId"),
                        readString(body, "sessionId"),
                        readString(body, "turnId"),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "artifact-create-upload") {
                assertExactKeys(body, ["now", "request", "scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.createArtifactUpload(
                        scope,
                        readString(body, "sessionId"),
                        readCreateArtifactUploadRequest(body),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "artifact-authorize-upload") {
                assertExactKeys(body, ["artifactId", "now", "scope", "sessionId", "uploadToken"]);
                return Response.json(
                    await this.#runtime.authorizeArtifactUpload(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "artifactId"),
                        readString(body, "uploadToken", 256),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "artifact-complete-upload") {
                assertExactKeys(body, ["contentBase64", "lease", "now", "scope"]);
                return Response.json(
                    await this.#runtime.completeArtifactUpload(
                        scope,
                        readArtifactUploadLease(body),
                        decodeBase64(readString(body, "contentBase64", 94 * 1024 * 1024)),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "artifact-read") {
                assertExactKeys(body, ["artifactId", "now", "scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.readArtifact(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "artifactId"),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "artifact-content") {
                assertExactKeys(body, ["artifactId", "scope", "sessionId"]);
                const content = await this.#runtime.readArtifactContent(
                    scope,
                    readString(body, "sessionId"),
                    readString(body, "artifactId"),
                    request.signal,
                );
                return Response.json({
                    artifact: content.artifact,
                    contentBase64: encodeBase64(content.bytes),
                });
            }
            if (operation === "artifact-resources") {
                assertExactKeys(body, ["artifactIds", "scope", "sessionId"]);
                const artifactIds = body["artifactIds"];
                if (!Array.isArray(artifactIds) || artifactIds.some((artifactId) => typeof artifactId !== "string")) {
                    throw new InternalRequestError("invalid_session_operation", "The artifact references are invalid");
                }
                return Response.json(
                    await this.#runtime.resolveArtifactResources(
                        scope,
                        readString(body, "sessionId"),
                        artifactIds.filter((artifactId) => typeof artifactId === "string"),
                        request.signal,
                    ),
                );
            }
            if (operation === "commit") {
                assertExactKeys(body, ["envelope", "now", "runtimeId", "scope"]);
                const envelope = decodeSessionEventEnvelope(readString(body, "envelope", 8_500_000));
                const result = await this.#operations.commitEvent(
                    scope,
                    readString(body, "runtimeId"),
                    envelope,
                    readInteger(body, "now"),
                    request.signal,
                );
                return Response.json(result);
            }
            if (operation === "set-binding") {
                assertExactKeys(body, ["binding", "now", "scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.setDefaultBinding(
                        scope,
                        readString(body, "sessionId"),
                        readBinding(body),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "read") {
                assertExactKeys(body, ["scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.readSession(scope, readString(body, "sessionId"), request.signal),
                );
            }
            if (operation === "configuration") {
                assertExactKeys(body, ["scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.readConfiguration(scope, readString(body, "sessionId"), request.signal),
                );
            }
            if (operation === "native-history") {
                assertExactKeys(body, ["scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.readNativeHistory(scope, readString(body, "sessionId"), request.signal),
                );
            }
            if (operation === "record-native-history") {
                assertExactKeys(body, ["history", "now", "runtimeId", "scope", "sessionId", "title"]);
                return Response.json(
                    await this.#runtime.recordNativeHistory(
                        scope,
                        readString(body, "runtimeId"),
                        readString(body, "sessionId"),
                        readString(body, "title", 500, true),
                        decodeNativeSessionHistory(body["history"]),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "turn") {
                assertExactKeys(body, ["scope", "sessionId", "turnId"]);
                return Response.json(
                    await this.#runtime.readTurn(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "turnId"),
                        request.signal,
                    ),
                );
            }
            if (operation === "turn-runtime") {
                assertExactKeys(body, ["scope", "sessionId", "turnId"]);
                return Response.json(
                    await this.#runtime.readTurnRuntime(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "turnId"),
                        request.signal,
                    ),
                );
            }
            if (operation === "command-runtime") {
                assertExactKeys(body, ["commandId", "scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.readCommandRuntime(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "commandId"),
                        request.signal,
                    ),
                );
            }
            if (operation === "attempt") {
                assertExactKeys(body, ["attemptId", "scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.readAttempt(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "attemptId"),
                        request.signal,
                    ),
                );
            }
            if (operation === "interaction") {
                assertExactKeys(body, ["interactionId", "scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.readInteraction(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "interactionId"),
                        request.signal,
                    ),
                );
            }
            if (operation === "interaction-runtime") {
                assertExactKeys(body, ["interactionId", "scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.readInteractionRuntime(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "interactionId"),
                        request.signal,
                    ),
                );
            }
            if (operation === "pending-interactions") {
                assertExactKeys(body, ["scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.readPendingInteractions(scope, readString(body, "sessionId"), request.signal),
                );
            }
            if (operation === "accept-interaction-response") {
                assertExactKeys(body, [
                    "deliveryPayload",
                    "interactionId",
                    "now",
                    "responderId",
                    "response",
                    "scope",
                    "sessionId",
                ]);
                return Response.json(
                    await this.#runtime.acceptInteractionResponse(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "interactionId"),
                        readString(body, "responderId"),
                        decodeInteractionResponse(body["response"]),
                        readString(body, "deliveryPayload", 8_000_000),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "pending-daemon-deliveries") {
                assertExactKeys(body, ["limit", "runtimeId", "scope"]);
                return Response.json(
                    await this.#runtime.listPendingDaemonDeliveries(
                        scope,
                        readString(body, "runtimeId"),
                        readInteger(body, "limit"),
                        request.signal,
                    ),
                );
            }
            if (operation === "complete-pending-work") {
                assertExactKeys(body, ["now", "scope", "sessionId", "workId"]);
                return Response.json(
                    await this.#runtime.markPendingWorkCompleted(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "workId"),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "reconcile") {
                assertExactKeys(body, ["attemptId", "now", "outcome", "runtimeId", "scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.reconcileAttempt(
                        scope,
                        readString(body, "runtimeId"),
                        readString(body, "sessionId"),
                        readString(body, "attemptId"),
                        readReconciliationOutcome(body),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "messages") {
                assertExactKeys(body, ["cursor", "limit", "scope", "sessionId"]);
                const segments: OperationTimingMetric[] = [];
                const page = await measureSegment(segments, "query", "Session message query", () =>
                    this.#runtime.readMessages(
                        scope,
                        readString(body, "sessionId"),
                        readNullableString(body, "cursor"),
                        readInteger(body, "limit"),
                        request.signal,
                    ),
                );
                // Serialization must be measured on its own: it is the cost that grows with the page, and the
                // previous single "storage" timer stopped before it ran.
                const encoded = await measureSegment(segments, "serialize", "Session message serialization", () =>
                    compressJsonBody(page, request.signal),
                );
                return new Response(Uint8Array.from(encoded.body).buffer, {
                    headers: {
                        "content-encoding": encoded.contentEncoding,
                        "content-type": "application/json",
                        [DO_TIMING_HEADER]: encodeDoTiming(segments),
                    },
                });
            }
            if (operation === "events") {
                assertExactKeys(body, ["cursor", "limit", "scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.readEvents(
                        scope,
                        readString(body, "sessionId"),
                        readNullableString(body, "cursor"),
                        readInteger(body, "limit"),
                        request.signal,
                    ),
                );
            }
            if (operation === "wait-events") {
                assertExactKeys(body, ["cursor", "limit", "scope", "sessionId", "waitMilliseconds"]);
                return Response.json(
                    await this.#runtime.waitForEvents(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "cursor", 512, true),
                        readInteger(body, "limit"),
                        readInteger(body, "waitMilliseconds"),
                        request.signal,
                    ),
                );
            }
            if (operation === "detail") {
                assertExactKeys(body, ["attemptId", "scope", "sessionId", "toolCallId"]);
                return Response.json(
                    await this.#runtime.readToolCallDetail(
                        scope,
                        readString(body, "sessionId"),
                        readString(body, "attemptId"),
                        readString(body, "toolCallId"),
                        request.signal,
                    ),
                );
            }
            if (operation === "export") {
                assertExactKeys(body, ["scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.exportSession(scope, readString(body, "sessionId"), request.signal),
                );
            }
            if (operation === "import") {
                assertExactKeys(body, ["binding", "exported", "now", "scope"]);
                const summary = await this.#operations.importSession(
                    scope,
                    body["exported"],
                    readBinding(body),
                    readInteger(body, "now"),
                    request.signal,
                );
                return Response.json(summary);
            }
            if (operation === "delete") {
                assertExactKeys(body, ["now", "scope", "sessionId"]);
                return Response.json(
                    await this.#runtime.deleteSession(
                        scope,
                        readString(body, "sessionId"),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "disconnect") {
                assertExactKeys(body, ["now", "runtimeId", "scope"]);
                return Response.json(
                    await this.#runtime.markRuntimeDisconnected(
                        scope,
                        readString(body, "runtimeId"),
                        readInteger(body, "now"),
                        request.signal,
                    ),
                );
            }
            if (operation === "archive") {
                assertExactKeys(body, ["scope", "sessionId"]);
                return Response.json({
                    completed: await this.#runtime.runArchiveWork(scope, readString(body, "sessionId"), request.signal),
                });
            }
            throw new InternalRequestError("session_not_found", "The session operation does not exist", 404);
        } catch (error) {
            if (request.signal.aborted) {
                throw error;
            }
            if (isHttpError(error)) {
                await this.#operations.recoverFromFailure(error, request.signal);
                return errorResponse(error);
            }
            console.error("Session Durable Object operation failed", error);
            return Response.json(
                {
                    error: {
                        code: "session_storage_unavailable",
                        message: "The session storage is unavailable",
                    },
                },
                { status: 503 },
            );
        }
    }
}

export function createDoRoutes(runtime: SqliteSessionRuntime, operations: DoService) {
    const routes = new DoRoutes(runtime, operations);
    return new Hono().all("*", (c) => routes.fetch(c.req.raw));
}
