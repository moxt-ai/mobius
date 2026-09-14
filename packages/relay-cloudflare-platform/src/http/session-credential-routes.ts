import { validateIdentifier } from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import * as v from "valibot";
import { bodyParser } from "../middleware/body-parser.ts";
import { browserCors } from "../middleware/browser-cors.ts";
import type { ConversationHttpEnvironment } from "./conversation-http-environment.ts";
import { bearer } from "./conversation-request.ts";

const issueSessionCredentialSchema = v.strictObject({
    expiresInSeconds: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export function createSessionCredentialRoutes() {
    return new Hono<ConversationHttpEnvironment>({ strict: false })
        .basePath("/v1/projects/:projectId/sessions/:sessionId/access-credentials")
        .use("*", browserCors)
        .post("/", bodyParser(issueSessionCredentialSchema), async (context) => {
            const projectId = validateIdentifier(context.req.param("projectId"), "project_id");
            const sessionId = validateIdentifier(context.req.param("sessionId"), "session_id");
            const token = bearer(context.req.raw);
            await context.env.sessions.readSession(projectId, token, sessionId, context.var.signal);
            context.header("Cache-Control", "no-store");
            return context.json(
                await context.env.sessionAccess.issue(
                    projectId,
                    sessionId,
                    token,
                    context.req.valid("json").expiresInSeconds,
                    context.var.signal,
                ),
                201,
            );
        });
}
