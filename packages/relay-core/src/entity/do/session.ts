import type { SessionOperationFailedEvent } from "@moxt-ai/mobius-protocol";
import type { HttpError } from "../http-error.ts";

export class ProjectScope {
    readonly projectId: string;

    constructor(projectId: string) {
        this.projectId = projectId;
    }
}

function sessionRuntimeErrorStatus(code: string): number {
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
    if (
        code === "session_not_found" ||
        code === "artifact_not_found" ||
        code === "interaction_not_found" ||
        code === "pending_work_not_found"
    ) {
        return 404;
    }
    if (code === "session_access_denied" || code === "artifact_upload_unauthorized") {
        return 403;
    }
    if (code === "session_deleted" || code === "cursor_expired" || code === "artifact_upload_expired") {
        return 410;
    }
    if (code === "session_quota_exceeded") {
        return 429;
    }
    if (
        code === "session_busy" ||
        code === "session_conflict" ||
        code === "session_history_not_retained" ||
        code === "idempotency_conflict" ||
        code === "interaction_conflict" ||
        code === "event_source_conflict" ||
        code === "artifact_upload_closed" ||
        code === "artifact_not_ready"
    ) {
        return 409;
    }
    if (code === "content_too_large") {
        return 413;
    }
    if (
        code === "invalid_cursor" ||
        code === "invalid_export" ||
        code === "invalid_page_size" ||
        code === "invalid_request" ||
        code === "artifact_content_mismatch"
    ) {
        return 400;
    }
    return 503;
}

interface SessionRuntimeErrorOptions extends ErrorOptions {
    readonly runtimeTimings?: NonNullable<SessionOperationFailedEvent["runtimeTimings"]> | undefined;
}

export class SessionRuntimeError extends Error implements HttpError {
    readonly code: string;
    readonly httpStatus: number;
    readonly runtimeTimings: NonNullable<SessionOperationFailedEvent["runtimeTimings"]>;

    constructor(code: string, message: string, options: SessionRuntimeErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.httpStatus = sessionRuntimeErrorStatus(code);
        this.name = "SessionRuntimeError";
        this.runtimeTimings = options.runtimeTimings ?? [];
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.code, message: this.message } },
        status: this.httpStatus,
    });
}
