import {
    createMobiusApplication,
    errorMiddleware,
    type RelayContext,
    rethrowHonoError,
} from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";

export function createProjectApplication() {
    const projectApplication = createMobiusApplication();
    return new Hono<{
        readonly Bindings: { readonly relay: RelayContext; readonly allowedOrigins: ReadonlySet<string> };
    }>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .all("*", async (context) => await projectApplication.fetch(context.req.raw, context.env.relay));
}
