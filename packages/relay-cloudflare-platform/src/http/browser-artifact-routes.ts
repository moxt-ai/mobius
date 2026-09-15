import {
    CreateArtifactUploadRequest,
    ConversationPermission as Permission,
    RequestBodyError,
    readBoundedBytesBody,
    SessionRuntimeError,
    validateIdentifier,
} from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import * as v from "valibot";
import { bodyParser } from "../middleware/body-parser.ts";
import type { ConversationHttpEnvironment } from "./conversation-http-environment.ts";
import { bearer, requestedProjectId } from "./conversation-request.ts";

const artifactUploadSchema = v.strictObject({
    byteLength: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    mediaType: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    sha256: v.pipe(v.string(), v.length(64), v.regex(/^[a-f0-9]{64}$/)),
});

export function createBrowserArtifactRoutes() {
    return new Hono<ConversationHttpEnvironment>({ strict: false })
        .post("/artifacts", bodyParser(artifactUploadSchema), async (context) => {
            const value = context.req.valid("json");
            const access = await context.env.access.authorize(
                requestedProjectId(context.req.raw),
                bearer(context.req.raw),
                Permission.ArtifactWrite,
                context.var.signal,
            );
            return context.json(
                await context.env.sessions.createConversationArtifactUpload(
                    access,
                    new CreateArtifactUploadRequest(value.name, value.mediaType, value.byteLength, value.sha256),
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
                201,
            );
        })
        .put("/artifacts/:artifactId/content", async (context) => {
            const access = await context.env.access.authorize(
                requestedProjectId(context.req.raw),
                bearer(context.req.raw),
                Permission.ArtifactWrite,
                context.var.signal,
            );
            const lease = await context.env.sessions.authorizeConversationArtifactUpload(
                access,
                validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                context.req.header("x-mobius-upload-token") ?? "",
                context.env.nowEpochMilliseconds(),
                context.var.signal,
            );
            if (context.req.header("content-type") !== lease.artifact.mediaType) {
                throw new SessionRuntimeError(
                    "artifact_content_mismatch",
                    "The artifact media type does not match its authorization",
                );
            }
            let bytes: Uint8Array;
            try {
                bytes = await readBoundedBytesBody(context.req.raw, lease.artifact.byteLength);
            } catch (cause) {
                if (cause instanceof RequestBodyError) {
                    throw new SessionRuntimeError(
                        "artifact_content_mismatch",
                        "The artifact body does not match its authorization",
                        { cause },
                    );
                }
                throw cause;
            }
            return context.json(
                await context.env.sessions.completeConversationArtifactUpload(
                    access,
                    lease,
                    bytes,
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
            );
        })
        .get("/artifacts/:artifactId", async (context) => {
            const access = await context.env.access.authorize(
                requestedProjectId(context.req.raw),
                bearer(context.req.raw),
                Permission.ArtifactRead,
                context.var.signal,
            );
            return context.json(
                await context.env.sessions.readConversationArtifact(
                    access,
                    validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                    context.env.nowEpochMilliseconds(),
                    context.var.signal,
                ),
            );
        })
        .get("/artifacts/:artifactId/content", async (context) => {
            const access = await context.env.access.authorize(
                requestedProjectId(context.req.raw),
                bearer(context.req.raw),
                Permission.ArtifactRead,
                context.var.signal,
            );
            const content = await context.env.sessions.readConversationArtifactContent(
                access,
                validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                context.var.signal,
            );
            return new Response(Uint8Array.from(content.bytes), {
                headers: {
                    "content-length": content.bytes.byteLength.toString(),
                    "content-type": content.artifact.mediaType,
                    "x-mobius-artifact-id": content.artifact.artifactId,
                    "x-mobius-sha256": content.artifact.sha256,
                },
            });
        });
}
