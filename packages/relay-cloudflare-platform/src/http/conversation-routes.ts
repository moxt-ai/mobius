import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { errorMiddleware, rethrowHonoError } from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import { createBrowserRoutes } from "./browser-routes.ts";
import { createConversationCredentialRoutes } from "./conversation-credential-routes.ts";
import type { ConversationHttpEnvironment } from "./conversation-http-environment.ts";
import { createSessionCredentialRoutes } from "./session-credential-routes.ts";

const OPERATION_TIMEOUT_MILLISECONDS = 15_000;

export function createConversationApplication() {
    return new Hono<ConversationHttpEnvironment>({ strict: false })
        .basePath(MOBIUS_API_PREFIX)
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
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
        .route("/", createConversationCredentialRoutes())
        .route("/", createSessionCredentialRoutes())
        .route("/v1/client/session", createBrowserRoutes());
}
