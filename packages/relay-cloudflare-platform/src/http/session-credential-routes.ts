import { ProjectAuthenticationError, type RelayContext, validateIdentifier } from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import * as v from "valibot";
import { bodyParser } from "../middleware/body-parser.ts";
import { createBrowserCors } from "../middleware/browser-cors.ts";
import { sessionAccessTargetMiddleware } from "../middleware/session-access-target.ts";
import type { SessionAccessService, SessionAccessTarget } from "../service/session-access-service.ts";

const issueSessionCredentialSchema = v.strictObject({
    expiresInSeconds: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

interface SessionCredentialRouteEnvironment {
    readonly Variables: {
        readonly relay: RelayContext;
        readonly sessionAccess: SessionAccessService;
        readonly sessionAccessTarget: SessionAccessTarget;
        readonly signal: AbortSignal;
    };
}

function bearer(request: Request): string {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
        throw new ProjectAuthenticationError("project_credential_invalid", "A Project credential is required");
    }
    const credential = authorization.slice("Bearer ".length);
    if (credential.length === 0 || credential.length > 16 * 1_024) {
        throw new ProjectAuthenticationError("project_credential_invalid", "A Project credential is required");
    }
    return credential;
}

export function createSessionCredentialRoutes(allowedOrigins: ReadonlySet<string>) {
    return new Hono<SessionCredentialRouteEnvironment>({ strict: false })
        .use(
            "/:sessionId/access-credentials",
            createBrowserCors(
                ["GET", "POST", "PUT"],
                ["authorization", "content-type", "x-mobius-upload-token"],
                allowedOrigins,
            ),
        )
        .post(
            "/:sessionId/access-credentials",
            sessionAccessTargetMiddleware,
            bodyParser(issueSessionCredentialSchema),
            async (context) => {
                const projectId = validateIdentifier(context.req.param("projectId") ?? "", "project_id");
                const sessionId = validateIdentifier(context.req.param("sessionId"), "session_id");
                const token = bearer(context.req.raw);
                await context.var.relay.services.sessions.readSession(projectId, token, sessionId, context.var.signal);
                context.header("Cache-Control", "no-store");
                return context.json(
                    await context.var.sessionAccess.issue(
                        projectId,
                        sessionId,
                        token,
                        context.req.valid("json").expiresInSeconds,
                        context.var.signal,
                    ),
                    201,
                );
            },
        );
}
