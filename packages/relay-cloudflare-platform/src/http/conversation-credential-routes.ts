import { validateIdentifier } from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import * as v from "valibot";
import { bodyParser } from "../middleware/body-parser.ts";
import type { ConversationHttpEnvironment } from "./conversation-http-environment.ts";
import { bearer, requestedProjectId } from "./conversation-request.ts";

const nonnegativeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const issueConversationCredentialSchema = v.strictObject({
    actorRef: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    expiresInSeconds: nonnegativeIntegerSchema,
    permissions: v.array(v.string()),
});
const rotateCredentialSchema = v.strictObject({ expiresInSeconds: nonnegativeIntegerSchema });
const emptyBodySchema = v.strictObject({});

export function createConversationCredentialRoutes() {
    return new Hono<ConversationHttpEnvironment>({ strict: false })
        .post(
            "/v1/projects/:projectId/conversations/:conversationId/access-credentials",
            bodyParser(issueConversationCredentialSchema),
            async (context) => {
                const value = context.req.valid("json");
                return context.json(
                    await context.env.access.issueForConversation(
                        requestedProjectId(context.req.raw),
                        validateIdentifier(context.req.param("conversationId"), "conversation_id"),
                        bearer(context.req.raw),
                        value.actorRef,
                        value.permissions,
                        value.expiresInSeconds,
                        context.var.signal,
                    ),
                    201,
                );
            },
        )
        .post(
            "/v1/projects/:projectId/conversation-access-credentials/:credentialId/rotate",
            bodyParser(rotateCredentialSchema),
            async (context) => {
                const value = context.req.valid("json");
                const credentialId = validateIdentifier(context.req.param("credentialId"), "credential_id");
                const replacement = await context.env.access.rotate(
                    requestedProjectId(context.req.raw),
                    credentialId,
                    bearer(context.req.raw),
                    value.expiresInSeconds,
                    context.var.signal,
                );
                context.env.streams.revoke(credentialId);
                return context.json(replacement, 201);
            },
        )
        .post(
            "/v1/projects/:projectId/conversation-access-credentials/:credentialId/revoke",
            bodyParser(emptyBodySchema),
            async (context) => {
                const credentialId = validateIdentifier(context.req.param("credentialId"), "credential_id");
                const revocation = await context.env.access.revoke(
                    requestedProjectId(context.req.raw),
                    credentialId,
                    bearer(context.req.raw),
                    context.var.signal,
                );
                context.env.streams.revoke(credentialId);
                return context.json(revocation);
            },
        );
}
