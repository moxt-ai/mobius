import { Hono } from "hono";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import { createBrowserCors } from "../middleware/browser-cors.ts";
import { createBrowserArtifactRoutes } from "./browser-artifact-routes.ts";
import { createBrowserSessionRoutes } from "./browser-session-routes.ts";
import type { ConversationHttpEnvironment } from "./conversation-http-environment.ts";

const FORBIDDEN_BROWSER_TARGET_PARAMETERS = Object.freeze([
    "botId",
    "conversationId",
    "projectId",
    "runtimeId",
    "sessionId",
]);

export function createBrowserRoutes() {
    return new Hono<ConversationHttpEnvironment>({ strict: false })
        .use("*", async (context, next) => {
            const parameters = new URL(context.req.raw.url).searchParams;
            if (FORBIDDEN_BROWSER_TARGET_PARAMETERS.some((name) => parameters.has(name))) {
                throw new PlatformControlPlaneError(
                    "browser_target_not_allowed",
                    "Browser Session routes do not accept resource target identifiers",
                    400,
                );
            }
            await next();
            return context.res;
        })
        .use("*", createBrowserCors(["GET", "POST", "PUT"], ["authorization", "content-type", "x-mobius-upload-token"]))
        .route("/", createBrowserSessionRoutes())
        .route("/", createBrowserArtifactRoutes());
}
