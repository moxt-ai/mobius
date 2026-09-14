import { ProjectAuthenticationError } from "../../entity/authentication/project-authentication.ts";
import { BotApiError, type BotFailureKind } from "../../entity/bot/bot-error.ts";
import { SessionRuntimeError } from "../../entity/do/session.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";

export function botErrorResponse(error: unknown): Response {
    if (error instanceof BotApiError) {
        return Response.json(
            { error: { code: error.code, message: error.message } },
            { status: botFailureStatus(error.kind) },
        );
    }
    if (error instanceof PairingDirectoryError) {
        const status =
            error.code === "directory_unavailable" ? 503 : error.code === "owner_access_required" ? 403 : 401;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    if (error instanceof ProjectAuthenticationError) {
        return Response.json(
            { error: { code: error.code, message: error.message } },
            { status: projectAuthenticationErrorStatus(error.code) },
        );
    }
    if (error instanceof SessionRuntimeError) {
        return Response.json(
            { error: { code: error.code, message: error.message } },
            { status: botSessionErrorStatus(error.code) },
        );
    }
    console.error("Bot API operation failed", error);
    return Response.json(
        { error: { code: "bot_service_unavailable", message: "The Bot service is unavailable" } },
        { status: 503 },
    );
}

function botFailureStatus(kind: BotFailureKind): number {
    switch (kind) {
        case "invalid-input":
            return 400;
        case "input-too-large":
            return 413;
        case "unauthenticated":
            return 401;
        case "access-denied":
            return 403;
        case "not-found":
            return 404;
        case "conflict":
            return 409;
        case "capacity-exceeded":
            return 429;
        case "unavailable":
            return 503;
        default: {
            const unreachable: never = kind;
            return unreachable;
        }
    }
}

function projectAuthenticationErrorStatus(code: string): number {
    switch (code) {
        case "credential_expired":
        case "credential_revoked":
        case "external_algorithm_invalid":
        case "external_audience_invalid":
        case "external_claims_invalid":
        case "external_credential_invalid":
        case "external_identity_expired":
        case "external_identity_invalid":
        case "external_identity_not_active":
        case "external_issuer_invalid":
        case "external_provider_invalid":
        case "external_signature_invalid":
        case "external_signing_key_unknown":
        case "external_subject_invalid":
        case "project_credential_invalid":
            return 401;
        case "external_identity_not_granted":
        case "owner_access_required":
        case "project_access_denied":
        case "project_permission_denied":
            return 403;
        case "application_credential_not_found":
        case "external_identity_binding_not_found":
        case "external_provider_unknown":
        case "owner_credential_not_found":
        case "project_application_not_found":
            return 404;
        case "application_credential_rotation_conflict":
        case "external_identity_binding_conflict":
        case "owner_credential_rotation_conflict":
        case "project_application_conflict":
            return 409;
        case "access_credential_lifetime_invalid":
        case "application_credential_lifetime_invalid":
        case "audit_page_invalid":
        case "credential_overlap_invalid":
        case "external_identity_not_fresh":
        case "project_permission_invalid":
            return 400;
        case "external_provider_timeout":
            return 504;
        case "external_jwks_invalid":
        case "external_provider_configuration_invalid":
        case "external_provider_unavailable":
        case "project_authentication_unavailable":
        case "project_authorization_record_invalid":
            return 503;
        default:
            return 503;
    }
}

function botSessionErrorStatus(code: string): number {
    if (code === "execution_capability_invalid") {
        return 401;
    }
    if (
        code === "conversation_access_denied" ||
        code === "delivery_target_not_allowed" ||
        code === "execution_context_mismatch"
    ) {
        return 403;
    }
    if (code === "execution_capability_expired") {
        return 410;
    }
    if (code === "queue_full") {
        return 429;
    }
    if (code === "idempotency_conflict" || code === "session_busy") {
        return 409;
    }
    if (code === "invalid_cursor" || code === "invalid_request") {
        return 400;
    }
    return 503;
}
