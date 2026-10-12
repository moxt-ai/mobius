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
        return await context.env.RECORDING.fetch(
            new Request(`https://recording.internal${recordingPath}`, { signal: context.req.raw.signal }),
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
        return await readRecording(context, projectId, recordingPath);
    })
    .get("/sessions/:sessionId/events", async (context): Promise<Response> => {
        const query = v.safeParse(recordingQuery, { runtimeId: context.req.query("runtimeId") ?? "" });
        const projectId = decodedIdentifier(context.req.param("projectId"));
        const sessionId = decodedIdentifier(context.req.param("sessionId"));
        if (!query.success || projectId === null || sessionId === null || !isIdentifier(query.output.runtimeId)) {
            return errorResponse("invalid_request", "The Recording target is invalid", 400);
        }
        const recordingPath = `/v1/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(
            query.output.runtimeId,
        )}/sessions/${encodeURIComponent(sessionId)}/events`;
        return await readRecording(context, projectId, recordingPath);
    });
