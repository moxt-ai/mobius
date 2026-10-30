import { ProjectPermission, toHttpError, validateIdentifier } from "@moxt-ai/mobius-relay-core";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import type { SessionAccessService } from "../service/session-access-service.ts";

/** Shared by transport admission and execution; never executes a content write. */
export async function authorizeSessionContentUpload(request: Request, sessions: SessionAccessService) {
    const path = new URL(request.url).pathname;
    const prefix = `${MOBIUS_API_PREFIX}/v1/projects/`;
    const parts = path.startsWith(prefix) ? path.slice(prefix.length).split("/") : [];
    const [projectId, resource, sessionId, operation, contentKey] = parts;
    if (
        request.method !== "PUT" ||
        parts.length !== 5 ||
        resource !== "sessions" ||
        operation !== "content" ||
        projectId === undefined ||
        sessionId === undefined ||
        contentKey === undefined ||
        !/^[a-f0-9]{64}$/u.test(contentKey)
    ) {
        return Response.json(
            { error: { code: "invalid_target", message: "A Session content upload is required" } },
            { status: 400 },
        );
    }
    const credential = (request.headers.get("authorization") ?? "").match(/^Bearer ([^\s]+)$/u)?.[1];
    if (credential === undefined) {
        return Response.json(
            { error: { code: "session_access_required", message: "A Session credential is required" } },
            { status: 401 },
        );
    }
    try {
        const access = await sessions.authorizeSession(
            {
                kind: "session",
                projectId: validateIdentifier(projectId, "project_id"),
                sessionId: validateIdentifier(sessionId, "session_id"),
            },
            credential,
            ProjectPermission.SessionWrite,
            request.signal,
        );
        return { access, sessionId, contentKey };
    } catch (cause) {
        request.signal.throwIfAborted();
        const error = toHttpError(cause);
        return Response.json(error.body, { status: error.status });
    }
}
