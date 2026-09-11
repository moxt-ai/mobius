import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
import { browserCors } from "../middleware/browser-cors.ts";
import { createBrowserArtifactRoutes } from "./browser-artifact-routes.ts";
import { createBrowserSessionRoutes } from "./browser-session-routes.ts";
import { createConversationCredentialRoutes } from "./conversation-credential-routes.ts";
import { conversationErrorResponse } from "./conversation-error-response.ts";
import type { ConversationHttpEnvironment } from "./conversation-http-environment.ts";

const OPERATION_TIMEOUT_MILLISECONDS = 15_000;
const FORBIDDEN_BROWSER_TARGET_PARAMETERS = Object.freeze([
    "botId",
    "conversationId",
    "projectId",
    "runtimeId",
    "sessionId",
]);

export function createConversationApplication() {
    return new Hono<ConversationHttpEnvironment>({ strict: false })
        .basePath(MOBIUS_API_PREFIX)
        .use("*", async (context, next) => {
            if (context.req.path.startsWith(`${MOBIUS_API_PREFIX}/v1/client/session`)) {
                const parameters = new URL(context.req.raw.url).searchParams;
                if (FORBIDDEN_BROWSER_TARGET_PARAMETERS.some((name) => parameters.has(name))) {
                    throw new PlatformControlPlaneError(
                        "browser_target_not_allowed",
                        "Browser Session routes do not accept resource target identifiers",
                        400,
                    );
                }
            }
            await next();
            return context.res;
        })
        .use("*", browserCors)
        .use("*", async (context, next) => {
            const stream =
                context.req.path === `${MOBIUS_API_PREFIX}/v1/client/session/events` &&
                context.req.header("accept")?.includes("text/event-stream") === true;
            context.set(
                "signal",
                stream
                    ? context.req.raw.signal
                    : AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MILLISECONDS)]),
            );
            await next();
            return context.res;
        })
        .onError(conversationErrorResponse)
        .route("/", createConversationCredentialRoutes())
        .route("/", createBrowserSessionRoutes())
        .route("/", createBrowserArtifactRoutes());
}
