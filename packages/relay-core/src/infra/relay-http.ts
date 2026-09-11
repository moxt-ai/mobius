import { ProjectAuthenticationError } from "../entity/authentication/project-authentication.ts";
import {
    type AttemptReconciliationOutcome,
    CreateSessionRequest,
    SessionRecordingPolicy,
    SessionRuntimeError,
} from "../entity/do/session.ts";
import { PairingDirectoryError, validateIdentifier } from "../entity/pairing/pairing.ts";
import { RequestBodyError, readBoundedUtf8Body } from "./bounded-request-body.ts";

const MAX_REQUEST_BODY_LENGTH = 16 * 1024;
export const MAX_IMPORT_BODY_LENGTH = 96 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
        throw new PairingDirectoryError("invalid_request", "The request fields are invalid");
    }
}

export async function parseJsonBody(
    request: Request,
    maximumLength = MAX_REQUEST_BODY_LENGTH,
): Promise<Readonly<Record<string, unknown>>> {
    let encoded: string;
    try {
        encoded = await readBoundedUtf8Body(request, maximumLength);
    } catch (cause) {
        if (cause instanceof RequestBodyError) {
            throw new PairingDirectoryError(
                "invalid_request",
                cause.code === "body_too_large" ? "The request body is too large" : "The request body is invalid",
                { cause },
            );
        }
        throw cause;
    }
    if (encoded.length === 0) {
        throw new PairingDirectoryError("invalid_request", "The request body is invalid");
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new PairingDirectoryError("invalid_request", "The request body is not valid JSON", { cause });
    }
    if (!isRecord(value)) {
        throw new PairingDirectoryError("invalid_request", "The request body must be a JSON object");
    }
    return value;
}

export function readString(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength = 128,
    allowEmpty = false,
): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximumLength || (!allowEmpty && field.length === 0)) {
        throw new PairingDirectoryError("invalid_request", `The ${key} field is invalid`);
    }
    return field;
}

export function readInteger(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new PairingDirectoryError("invalid_request", `The ${key} field is invalid`);
    }
    return field;
}

export function bearerToken(request: Request): string {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
        throw new PairingDirectoryError("unauthorized", "A project bearer token is required");
    }
    return authorization.slice("Bearer ".length);
}

export function pageLimit(value: string | undefined): number {
    if (value === undefined) {
        return DEFAULT_PAGE_SIZE;
    }
    if (!/^\d+$/.test(value)) {
        throw new SessionRuntimeError("invalid_page_size", "The page size is invalid");
    }
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        throw new SessionRuntimeError(
            "invalid_page_size",
            `The page size must be between 1 and ${MAX_PAGE_SIZE.toString()}`,
        );
    }
    return limit;
}

export function optionalCursor(value: string | undefined): string | null {
    return value ?? null;
}

function reportUnexpectedError(error: unknown): void {
    console.error("Mobius relay request failed", error);
}

export function preserveCancellation(signal: AbortSignal, error: unknown): void {
    if (signal.aborted) {
        throw error;
    }
}

export function directoryError(error: unknown): Response {
    if (error instanceof ProjectAuthenticationError) {
        const publicCode =
            error.code === "project_credential_invalid" || error.code === "project_access_denied"
                ? "unauthorized"
                : error.code;
        const status =
            publicCode === "unauthorized" || publicCode === "credential_expired" || publicCode === "credential_revoked"
                ? 401
                : publicCode === "project_permission_denied"
                  ? 403
                  : publicCode === "project_authentication_unavailable" ||
                      publicCode === "project_authorization_record_invalid"
                    ? 503
                    : 400;
        return Response.json({ error: { code: publicCode, message: error.message } }, { status });
    }
    if (error instanceof PairingDirectoryError) {
        const status =
            error.code === "pairing_not_found" ||
            error.code === "runtime_not_found" ||
            error.code === "channel_not_found" ||
            error.code === "access_grant_invalid" ||
            error.code === "linked_device_not_found" ||
            error.code === "browser_credential_not_found"
                ? 404
                : error.code === "unauthorized" ||
                    error.code === "credential_expired" ||
                    error.code === "credential_revoked"
                  ? 401
                  : error.code === "owner_access_required"
                    ? 403
                    : error.code === "public_project_bootstrap_disabled"
                      ? 403
                      : error.code === "runtime_access_denied"
                        ? 403
                        : error.code === "access_grant_expired"
                          ? 410
                          : error.code === "access_grant_redeemed"
                            ? 409
                            : error.code === "pairing_timeout" || error.code === "directory_timeout"
                              ? 504
                              : error.code === "runtime_unavailable" || error.code === "idempotency_conflict"
                                ? 409
                                : error.code === "runtime_quota_exceeded"
                                  ? 429
                                  : error.code === "public_project_bootstrap_rate_limited"
                                    ? 429
                                    : error.code === "directory_unavailable" ||
                                        error.code === "runtime_disconnect_failed"
                                      ? 503
                                      : error.code === "workspace_required"
                                        ? 403
                                        : 400;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    reportUnexpectedError(error);
    return Response.json(
        {
            error: {
                code: "directory_unavailable",
                message: "The authorization directory is unavailable",
            },
        },
        { status: 503 },
    );
}

export function sessionError(error: unknown): Response {
    if (error instanceof PairingDirectoryError || error instanceof ProjectAuthenticationError) {
        return directoryError(error);
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
                    : error.code === "session_quota_exceeded"
                      ? 429
                      : error.code === "session_busy" ||
                          error.code === "session_conflict" ||
                          error.code === "idempotency_conflict" ||
                          error.code === "interaction_conflict" ||
                          error.code === "event_source_conflict" ||
                          error.code === "artifact_upload_closed" ||
                          error.code === "artifact_not_ready"
                        ? 409
                        : error.code === "content_too_large"
                          ? 413
                          : error.code === "invalid_cursor" ||
                              error.code === "invalid_export" ||
                              error.code === "invalid_page_size" ||
                              error.code === "invalid_request" ||
                              error.code === "artifact_content_mismatch"
                            ? 400
                            : 503;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    reportUnexpectedError(error);
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

export function createRequest(body: Readonly<Record<string, unknown>>): CreateSessionRequest {
    assertExactKeys(body, ["agentId", "bindingId", "directoryId", "policy", "runtimeId", "sessionId", "title"]);
    const { policy } = body;
    if (!isRecord(policy)) {
        throw new PairingDirectoryError("invalid_request", "The session policy is invalid");
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
        throw new PairingDirectoryError("invalid_request", "The session recording level is invalid");
    }
    return new CreateSessionRequest(
        validateIdentifier(readString(body, "sessionId"), "session_id"),
        validateIdentifier(readString(body, "runtimeId"), "runtime_id"),
        validateIdentifier(readString(body, "agentId"), "agent_id"),
        validateIdentifier(readString(body, "bindingId"), "binding_id"),
        validateIdentifier(readString(body, "directoryId"), "directory_id"),
        new SessionRecordingPolicy(
            level,
            readInteger(policy, "retentionMilliseconds"),
            readInteger(policy, "hotEventLimit"),
            readInteger(policy, "contentLimitBytes"),
            readInteger(policy, "idempotencyRetentionMilliseconds"),
        ),
        readString(body, "title", 500, true),
    );
}

export function reconciliationOutcome(body: Readonly<Record<string, unknown>>): AttemptReconciliationOutcome {
    const { outcome } = body;
    if (!isRecord(outcome) || typeof outcome["kind"] !== "string") {
        throw new PairingDirectoryError("invalid_request", "The reconciliation outcome is invalid");
    }
    if (outcome["kind"] === "running") {
        assertExactKeys(outcome, ["kind"]);
        return { kind: "running" };
    }
    if (outcome["kind"] === "cancelled") {
        assertExactKeys(outcome, ["kind"]);
        return { kind: "cancelled" };
    }
    if (outcome["kind"] === "succeeded") {
        assertExactKeys(outcome, ["kind", "stopReason"]);
        return {
            kind: "succeeded",
            stopReason: readString(outcome, "stopReason"),
        };
    }
    if (outcome["kind"] === "failed") {
        assertExactKeys(outcome, ["error", "kind"]);
        const error = outcome["error"];
        if (!isRecord(error)) {
            throw new PairingDirectoryError("invalid_request", "The reconciliation error is invalid");
        }
        assertExactKeys(error, ["code", "message", "retryable"]);
        if (typeof error["retryable"] !== "boolean") {
            throw new PairingDirectoryError("invalid_request", "The reconciliation error is invalid");
        }
        return {
            error: {
                code: validateIdentifier(readString(error, "code"), "error_code"),
                message: readString(error, "message", 2_000),
                retryable: error["retryable"],
            },
            kind: "failed",
        };
    }
    throw new PairingDirectoryError("invalid_request", "The reconciliation outcome is invalid");
}
