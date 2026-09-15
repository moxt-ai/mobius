import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    createPlatformMobiusApplication,
    errorMiddleware,
    type RelayContext,
    rethrowHonoError,
} from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import { createBrowserCors } from "../middleware/browser-cors.ts";

export function createProjectApplication() {
    const projectApplication = createPlatformMobiusApplication();
    return new Hono<{
        readonly Bindings: { readonly relay: RelayContext; readonly allowedOrigins: ReadonlySet<string> };
    }>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .use(
            `${MOBIUS_API_PREFIX}/v1/projects/:projectId/sessions/:sessionId/*`,
            createBrowserCors(["GET", "POST", "PUT"], ["authorization", "content-type", "x-mobius-upload-token"]),
        )
        .all("*", async (context) => await projectApplication.fetch(context.req.raw, context.env.relay));
}
