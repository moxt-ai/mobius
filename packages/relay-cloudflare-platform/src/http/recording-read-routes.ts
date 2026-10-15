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
const recordingCursor = v.pipe(v.string(), v.regex(/^(?:(?:0|[1-9][0-9]*)|v2:[1-9][0-9]*:(?:0|[1-9][0-9]*))$/u));
const turnPageQuery = v.object({
    before: v.optional(v.pipe(v.string(), v.regex(/^turn:[1-9][0-9]*$/u))),
    limit: v.optional(v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,2}$/u))),
});
const turnItemPageQuery = v.object({
    after: v.optional(v.pipe(v.string(), v.regex(/^item:(?:0|[1-9][0-9]*)$/u))),
    limit: v.optional(v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,3}$/u))),
});
const recordingIncrementalQuery = v.object({
    after: v.optional(recordingCursor),
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

function definedQuery(
    context: Context<PlatformApplicationEnvironment>,
    names: readonly string[],
): Record<string, string> {
    const values: Record<string, string> = {};
    for (const name of names) {
        const value = context.req.query(name);
        if (value !== undefined) {
            values[name] = value;
        }
    }
    return values;
}

function forwardedQuery(runtimeId: string, query: Readonly<Record<string, string | undefined>>): URLSearchParams {
    const forwarded = new URLSearchParams({ runtimeId });
    for (const [name, value] of Object.entries(query)) {
        if (value !== undefined) {
            forwarded.set(name, value);
        }
    }
    return forwarded;
}

/** Resolves the Recording Session addressed by a Turn history read. */
function turnTarget(context: Context<PlatformApplicationEnvironment>): {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionPath: string;
} | null {
    const runtimeId = context.req.query("runtimeId");
    const projectId = decodedIdentifier(context.req.param("projectId"));
    const sessionId = decodedIdentifier(context.req.param("sessionId"));
    if (runtimeId === undefined || !isIdentifier(runtimeId) || projectId === null || sessionId === null) {
        return null;
    }
    return {
        projectId,
        runtimeId,
        sessionPath: `/v1/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(
            runtimeId,
        )}/sessions/${encodeURIComponent(sessionId)}`,
    };
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
        return await readRecording(context, projectId, recordingPath);
    })
    .get("/sessions/:sessionId/events", async (context): Promise<Response> => {
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
    .get("/sessions/:sessionId/turns", async (context): Promise<Response> => {
        const target = turnTarget(context);
        const query = v.safeParse(turnPageQuery, definedQuery(context, ["before", "limit"]));
        if (target === null || !query.success) {
            return errorResponse("invalid_request", "The Recording Turn read is invalid", 400);
        }
        return await readRecording(
            context,
            target.projectId,
            `${target.sessionPath}/turns`,
            forwardedQuery(target.runtimeId, query.output),
        );
    })
    .get("/sessions/:sessionId/turns/:commandId/items", async (context): Promise<Response> => {
        const target = turnTarget(context);
        const commandId = decodedIdentifier(context.req.param("commandId"));
        const query = v.safeParse(turnItemPageQuery, definedQuery(context, ["after", "limit"]));
        if (target === null || commandId === null || !query.success) {
            return errorResponse("invalid_request", "The Recording Turn item read is invalid", 400);
        }
        return await readRecording(
            context,
            target.projectId,
            `${target.sessionPath}/turns/${encodeURIComponent(commandId)}/items`,
            forwardedQuery(target.runtimeId, query.output),
        );
    })
    .get("/sessions/:sessionId/turns/:commandId/items/:itemId", async (context): Promise<Response> => {
        const target = turnTarget(context);
        const commandId = decodedIdentifier(context.req.param("commandId"));
        const itemId = context.req.param("itemId");
        if (target === null || commandId === null || itemId.length === 0 || itemId.length > 4_200) {
            return errorResponse("invalid_request", "The Recording Turn item read is invalid", 400);
        }
        return await readRecording(
            context,
            target.projectId,
            `${target.sessionPath}/turns/${encodeURIComponent(commandId)}/items/${encodeURIComponent(itemId)}`,
            new URLSearchParams({ runtimeId: target.runtimeId }),
        );
    });

export const recordingSessionStatusRoutes = new Hono<PlatformApplicationEnvironment>()
    .get("/sessions", async (context, next) => {
        const projectId = decodedIdentifier(context.req.param("projectId"));
        const runtimeId = decodedIdentifier(context.req.param("runtimeId"));
        const sessionIds = new URL(context.req.raw.url).searchParams.getAll("sessionId");
        if (sessionIds.length === 0) {
            await next();
            return;
        }
        if (
            projectId === null ||
            runtimeId === null ||
            sessionIds.length === 0 ||
            sessionIds.some((id) => !isIdentifier(id))
        ) {
            return errorResponse("invalid_request", "The Recording Session status target is invalid", 400);
        }
        const forwarded = new URLSearchParams();
        for (const sessionId of sessionIds) {
            forwarded.append("sessionId", sessionId);
        }
        const recordingPath = `/v1/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(
            runtimeId,
        )}/sessions`;
        return await readRecording(context, projectId, recordingPath, forwarded);
    })
    .get("/sessions/:sessionId", async (context): Promise<Response> => {
        const projectId = decodedIdentifier(context.req.param("projectId"));
        const runtimeId = decodedIdentifier(context.req.param("runtimeId"));
        const sessionId = decodedIdentifier(context.req.param("sessionId"));
        if (projectId === null || runtimeId === null || sessionId === null) {
            return errorResponse("invalid_request", "The Recording Session status target is invalid", 400);
        }
        const recordingPath = `/v1/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(
            runtimeId,
        )}/sessions/${encodeURIComponent(sessionId)}`;
        return await readRecording(context, projectId, recordingPath);
    });
