import type { SessionOperationFailedEvent } from "@moxt-ai/mobius-protocol";
import type { HttpError } from "../http-error.ts";

export class ProjectScope {
    readonly projectId: string;

    constructor(projectId: string) {
        this.projectId = projectId;
    }
}

function sessionRuntimeErrorStatus(code: string): number {
    if (code === "session_not_found") {
        return 404;
    }
    if (code === "session_busy" || code === "session_conflict" || code === "idempotency_conflict") {
        return 409;
    }
    if (code === "invalid_cursor" || code === "invalid_request") {
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
