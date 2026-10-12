import { isIdentifier } from "@moxt-ai/mobius-protocol";
import { ProjectPermission } from "@moxt-ai/mobius-relay-core";
import { type Context, Hono } from "hono";
import * as v from "valibot";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import type { PlatformRelayBindings } from "../platform-worker.ts";
import type { PlatformControlPlaneService } from "../service/platform-control-plane-service.ts";
import type { RecordingPolicyService } from "../service/recording-policy-service.ts";

type PlatformApplicationEnvironment = {
    readonly Bindings: PlatformRelayBindings;
    readonly Variables: {
        readonly control: PlatformControlPlaneService;
        readonly recordingPolicies: RecordingPolicyService;
    };
};

const recordingQuery = v.object({ runtimeId: v.string() });
const recordingPosition = v.pipe(v.string(), v.regex(/^(?:0|[1-9][0-9]*)$/u));
const recordingIncrementalQuery = v.object({
    after: v.optional(recordingPosition),
    limit: v.optional(v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,4}$/u))),
});

function decodedIdentifier(value: string | undefined): string | null {
    if (value === undefined) {
        return null;
    }
    try {
        const decoded = decodeURIComponent(value);
        return isIdentifier(decoded) ? decoded : null;
    } catch {
        return null;
    }
}

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status });
}

function bearerToken(request: Request): string | null {
    return /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

async function readRecording(
    context: Context<PlatformApplicationEnvironment>,
    projectId: string,
    recordingPath: string,
    incrementalQuery: URLSearchParams = new URLSearchParams(),
): Promise<Response> {
    const credential = bearerToken(context.req.raw);
    if (credential === null) {
        return errorResponse("project_access_denied", "The Project credential is invalid", 401);
    }
    try {
        await context.var.control.authorizeProject(
            projectId,
            credential,
            ProjectPermission.SessionRead,
            context.req.header("user-agent") ?? "moxt-server",
            context.req.raw.signal,
        );
        const policy = await context.var.recordingPolicies.readProjectPolicy(projectId, context.req.raw.signal);
        if (policy.effectiveMode !== "enabled") {
            return errorResponse("recording_disabled", "Recording is disabled", 404);
        }
        if (context.env.RECORDING === undefined) {
            return errorResponse("recording_provider_unavailable", "Recording is unavailable", 503);
        }
        const query = incrementalQuery.toString();
        const target = query.length === 0 ? recordingPath : `${recordingPath}?${query}`;
        return await context.env.RECORDING.fetch(
            new Request(`https://recording.internal${target}`, { signal: context.req.raw.signal }),
        );
    } catch (cause) {
        if (cause instanceof PlatformControlPlaneError) {
            return errorResponse(cause.code, cause.message, cause.status);
        }
        throw cause;
    }
}

export const recordingReadRoutes = new Hono<PlatformApplicationEnvironment>()
    .get("/sessions", async (context): Promise<Response> => {
        const query = v.safeParse(recordingQuery, { runtimeId: context.req.query("runtimeId") ?? "" });
        const projectId = decodedIdentifier(context.req.param("projectId"));
        if (!query.success || projectId === null || !isIdentifier(query.output.runtimeId)) {
            return errorResponse("invalid_request", "The Recording target is invalid", 400);
        }
        const recordingPath = `/v1/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(
            query.output.runtimeId,
        )}/sessions`;
        const directoryQuery = new URLSearchParams(new URL(context.req.url).searchParams);
        directoryQuery.delete("runtimeId");
        return await readRecording(context, projectId, recordingPath, directoryQuery);
    })
    .get("/sessions/:sessionId/events", async (context): Promise<Response> => {
        if (context.req.param("projectId") === undefined) {
            return await readUnscopedRecording(context, decodedIdentifier(context.req.param("sessionId")), "events");
        }
        const query = v.safeParse(recordingQuery, { runtimeId: context.req.query("runtimeId") ?? "" });
        const incremental = v.safeParse(recordingIncrementalQuery, {
            ...(context.req.query("after") === undefined ? {} : { after: context.req.query("after") }),
            ...(context.req.query("limit") === undefined ? {} : { limit: context.req.query("limit") }),
        });
        const projectId = decodedIdentifier(context.req.param("projectId"));
        const sessionId = decodedIdentifier(context.req.param("sessionId"));
        if (!query.success || projectId === null || sessionId === null || !isIdentifier(query.output.runtimeId)) {
            return errorResponse("invalid_request", "The Recording target is invalid", 400);
        }
        if (!incremental.success) {
            return errorResponse("invalid_request", "The Recording incremental read is invalid", 400);
        }
        const forwarded = new URLSearchParams({ runtimeId: query.output.runtimeId });
        if (incremental.output.after !== undefined) {
            forwarded.set("after", incremental.output.after);
        }
        if (incremental.output.limit !== undefined) {
            forwarded.set("limit", incremental.output.limit);
        }
        const recordingPath = `/v1/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(
            query.output.runtimeId,
        )}/sessions/${encodeURIComponent(sessionId)}/events`;
        return await readRecording(context, projectId, recordingPath, forwarded);
    })
    .get("/sessions/:sessionId", async (context): Promise<Response> => {
        const sessionId = decodedIdentifier(context.req.param("sessionId"));
        if (sessionId === null) {
            return errorResponse("invalid_request", "The Recording target is invalid", 400);
        }
        return await readUnscopedRecording(context, sessionId, "metadata");
    })
    .get("/sessions/:sessionId/metadata", (context) =>
        readUnscopedRecording(context, decodedIdentifier(context.req.param("sessionId")), "metadata"),
    )
    .get("/sessions/:sessionId/target", (context) =>
        readUnscopedRecording(context, decodedIdentifier(context.req.param("sessionId")), "target"),
    )
    .get("/sessions/:sessionId/status", (context) =>
        readUnscopedRecording(context, decodedIdentifier(context.req.param("sessionId")), "status"),
    )
    .get("/sessions/:sessionId/delivery", (context) =>
        readUnscopedRecording(context, decodedIdentifier(context.req.param("sessionId")), "delivery"),
    )
    .get("/sessions/:sessionId/history", (context) =>
        readUnscopedRecording(context, decodedIdentifier(context.req.param("sessionId")), "history"),
    )
    .get("/sessions/:sessionId/export", (context) =>
        readUnscopedRecording(context, decodedIdentifier(context.req.param("sessionId")), "export"),
    )
    .get("/sessions/:sessionId/retention", (context) =>
        readUnscopedRecording(context, decodedIdentifier(context.req.param("sessionId")), "retention"),
    )
    .put(
        "/sessions/:sessionId/retention",
        async (context) =>
            await writeUnscopedRecording(context, decodedIdentifier(context.req.param("sessionId")), "retention"),
    )
    .delete(
        "/sessions/:sessionId",
        async (context) =>
            await writeUnscopedRecording(context, decodedIdentifier(context.req.param("sessionId")), "delete"),
    );

async function readUnscopedRecording(
    context: Context<PlatformApplicationEnvironment>,
    sessionId: string | null,
    operation: string,
): Promise<Response> {
    if (sessionId === null) {
        return errorResponse("invalid_request", "The Recording target is invalid", 400);
    }
    const target = await authorizeUnscopedTarget(context, sessionId, ProjectPermission.SessionRead);
    if (target instanceof Response) {
        return target;
    }
    const policy = await context.var.recordingPolicies.readProjectPolicy(target.projectId, context.req.raw.signal);
    if (policy.effectiveMode !== "enabled") {
        return errorResponse("recording_disabled", "Recording is disabled", 404);
    }
    return (
        (await context.env.RECORDING?.fetch(
            new Request(
                `https://recording.internal/v1/sessions/${encodeURIComponent(sessionId)}${operation === "metadata" ? "" : `/${operation}`}${
                    operation === "events" ? new URL(context.req.url).search : ""
                }`,
                { signal: context.req.raw.signal },
            ),
        )) ?? errorResponse("recording_provider_unavailable", "Recording is unavailable", 503)
    );
}

async function writeUnscopedRecording(
    context: Context<PlatformApplicationEnvironment>,
    sessionId: string | null,
    operation: string,
): Promise<Response> {
    if (sessionId === null) {
        return errorResponse("invalid_request", "The Recording target is invalid", 400);
    }
    const target = await authorizeUnscopedTarget(
        context,
        sessionId,
        operation === "delete" ? ProjectPermission.SessionDelete : ProjectPermission.SessionWrite,
    );
    if (target instanceof Response) {
        return target;
    }
    return (
        (await context.env.RECORDING?.fetch(
            new Request(
                `https://recording.internal/v1/sessions/${encodeURIComponent(sessionId)}${operation === "delete" ? "" : `/${operation}`}`,
                {
                    method: context.req.method,
                    ...(operation === "retention" ? { body: await context.req.text() } : {}),
                    signal: context.req.raw.signal,
                },
            ),
        )) ?? errorResponse("recording_provider_unavailable", "Recording is unavailable", 503)
    );
}

async function authorizeUnscopedTarget(
    context: Context<PlatformApplicationEnvironment>,
    sessionId: string,
    permission: ProjectPermission,
): Promise<Response | { readonly projectId: string }> {
    const credential = bearerToken(context.req.raw);
    if (credential === null) {
        return errorResponse("project_access_denied", "The Project credential is invalid", 401);
    }
    const targetResponse = await context.env.RECORDING?.fetch(
        new Request(`https://recording.internal/v1/sessions/${encodeURIComponent(sessionId)}/target`, {
            signal: context.req.raw.signal,
        }),
    );
    if (targetResponse === undefined || !targetResponse.ok) {
        await targetResponse?.body?.cancel();
        return errorResponse("session_not_found", "The Session is unavailable", 404);
    }
    const target: unknown = await targetResponse.json();
    if (typeof target !== "object" || target === null || !("projectId" in target) || !("runtimeId" in target)) {
        return errorResponse("session_not_found", "The Session is unavailable", 404);
    }
    const projectId = Reflect.get(target, "projectId");
    if (typeof projectId !== "string" || !isIdentifier(projectId)) {
        return errorResponse("session_not_found", "The Session is unavailable", 404);
    }
    try {
        await context.var.control.authorizeProject(
            projectId,
            credential,
            permission,
            context.req.header("user-agent") ?? "moxt-server",
            context.req.raw.signal,
        );
        return { projectId };
    } catch (cause) {
        if (cause instanceof PlatformControlPlaneError) {
            return errorResponse(cause.code, cause.message, cause.status);
        }
        throw cause;
    }
}
