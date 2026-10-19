import { MOBIUS_API_PREFIX, parseMobiusApiPrefix } from "@moxt-ai/mobius-sdk/protocol";
import { Hono } from "hono";
import { createChannelRoutes } from "./http/channel/channel-routes.ts";
import { rethrowHonoError } from "./http/middleware/error-middleware.ts";
import { createPairingClaimRoutes } from "./http/pairing/pairing-routes.ts";
import { createProjectRuntimePairingRoutes } from "./http/pairing/project-runtime-pairing-routes.ts";
import { createProjectRuntimeRoutes } from "./http/pairing/project-runtime-routes.ts";
import type { RelayHttpEnvironment } from "./http/relay-http-environment.ts";

export function createMobiusApplication(apiPrefix: string = MOBIUS_API_PREFIX) {
    return new Hono<RelayHttpEnvironment>()
        .basePath(parseMobiusApiPrefix(apiPrefix))
        .onError(rethrowHonoError)
        .notFound(notFoundResponse)
        .route("/pairings", createPairingClaimRoutes())
        .route("/", createProjectRuntimePairingRoutes())
        .route("/v1", createProjectRuntimePairingRoutes())
        .route("/", createProjectRuntimeRoutes())
        .route("/v1", createProjectRuntimeRoutes())
        .route("/channels", createChannelRoutes());
}

/** Unmatched routes must carry a stable machine-readable code so SDK callers can branch on it. */
export function notFoundResponse(): Response {
    return Response.json(
        { error: { code: "not_found", message: "The requested Mobius resource does not exist" } },
        { status: 404 },
    );
}
