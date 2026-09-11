import type { MiddlewareHandler } from "hono";
import { ProjectAuthenticationError } from "../../entity/authentication/project-authentication.ts";
import { isHttpError } from "../../entity/http-error.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";
import { errorResponseMiddleware } from "./error-response-middleware.ts";
import { requestTimeoutMiddleware } from "./request-timeout-middleware.ts";

const PAIRING_OPERATION_TIMEOUT_MILLISECONDS = 15_000;

function reportUnexpectedError(error: unknown): void {
    console.error("Mobius relay request failed", error);
}

function directoryErrorResponse(error: unknown): Response {
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

function sessionErrorResponse(error: unknown): Response {
    if (error instanceof PairingDirectoryError || error instanceof ProjectAuthenticationError) {
        return directoryErrorResponse(error);
    }
    if (isHttpError(error)) {
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.httpStatus });
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

export const directoryErrorMiddleware = errorResponseMiddleware<RelayHttpEnvironment>(directoryErrorResponse);
export const sessionErrorMiddleware = errorResponseMiddleware<RelayHttpEnvironment>(sessionErrorResponse);

export function pairingTimeoutMiddleware(message: string): MiddlewareHandler<RelayHttpEnvironment> {
    return requestTimeoutMiddleware<RelayHttpEnvironment>(
        PAIRING_OPERATION_TIMEOUT_MILLISECONDS,
        (cause) => new PairingDirectoryError("pairing_timeout", message, { cause }),
    );
}
