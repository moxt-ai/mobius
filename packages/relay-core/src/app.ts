import { MOBIUS_API_PREFIX, parseMobiusApiPrefix } from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";
import { createChannelRoutes } from "./http/channel/channel-routes.ts";
import { createSessionRoutes } from "./http/do/session-routes.ts";
import { rethrowHonoError } from "./http/middleware/error-middleware.ts";
import { createPairingClaimRoutes } from "./http/pairing/pairing-routes.ts";
import { createProjectRuntimePairingRoutes } from "./http/pairing/project-runtime-pairing-routes.ts";
import type { RelayHttpEnvironment } from "./http/relay-http-environment.ts";

export function createPlatformMobiusApplication(apiPrefix: string = MOBIUS_API_PREFIX) {
    return new Hono<RelayHttpEnvironment>()
        .basePath(parseMobiusApiPrefix(apiPrefix))
        .onError(rethrowHonoError)
        .route("/pairings", createPairingClaimRoutes())
        .route("/", createProjectRuntimePairingRoutes())
        .route("/v1", createProjectRuntimePairingRoutes())
        .route("/channels", createChannelRoutes())
        .route("/", createSessionRoutes())
        .route("/v1", createSessionRoutes());
}
