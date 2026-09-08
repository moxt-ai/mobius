import { MOBIUS_API_PREFIX, parseMobiusApiPrefix } from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";
import { createChannelRoutes } from "./http/channel/channel-routes.ts";
import { createHealthRoutes } from "./http/health/health-routes.ts";
import { createPairingRoutes } from "./http/pairing/pairing-routes.ts";
import type { RelayHttpEnvironment } from "./http/relay-http-environment.ts";
import { createSessionRoutes } from "./http/session/session-routes.ts";

export function createMobiusApplication(apiPrefix: string = MOBIUS_API_PREFIX) {
    return new Hono<RelayHttpEnvironment>()
        .basePath(parseMobiusApiPrefix(apiPrefix))
        .route("/", createHealthRoutes())
        .route("/pairings", createPairingRoutes())
        .route("/channels", createChannelRoutes())
        .route("/", createSessionRoutes());
}
