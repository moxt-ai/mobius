import {
    ConversationAccessError,
    PairingDirectoryError,
    ProjectAuthenticationError,
    SessionRuntimeError,
} from "@moxt-ai/mobius-relay-core";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";

export function conversationErrorResponse(error: unknown): Response {
    if (error instanceof PlatformControlPlaneError) {
        return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    if (error instanceof ConversationAccessError) {
        const status = error.code === "conversation_permission_denied" ? 403 : 401;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    if (error instanceof ProjectAuthenticationError) {
        const status = error.code === "project_permission_denied" || error.code === "project_access_denied" ? 403 : 401;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    if (error instanceof PairingDirectoryError) {
        const status =
            error.code === "runtime_access_denied"
                ? 403
                : error.code === "runtime_unavailable" || error.code === "idempotency_conflict"
                  ? 409
                  : error.code === "unauthorized"
                    ? 401
                    : 400;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
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
                    : error.code === "session_busy" ||
                        error.code === "session_conflict" ||
                        error.code === "idempotency_conflict" ||
                        error.code === "interaction_conflict" ||
                        error.code === "artifact_upload_closed" ||
                        error.code === "artifact_not_ready"
                      ? 409
                      : error.code === "content_too_large"
                        ? 413
                        : error.code === "invalid_cursor" ||
                            error.code === "invalid_page_size" ||
                            error.code === "invalid_request" ||
                            error.code === "artifact_content_mismatch"
                          ? 400
                          : 503;
        return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    console.error("Platform Conversation request failed", error);
    return Response.json(
        { error: { code: "conversation_service_unavailable", message: "The Conversation service is unavailable" } },
        { status: 503 },
    );
}
