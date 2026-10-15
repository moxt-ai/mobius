import { Hono } from "hono";
import {
    validateAgents,
    validateDisplayName,
    validateIdentifier,
    validateLegacyInstallableAgents,
    validatePairingCode,
} from "../../entity/pairing/pairing.ts";
import { bearerToken, readString } from "../../infra/relay-http.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import { pairingTimeoutMiddleware } from "../middleware/pairing-timeout-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

export function createProjectRuntimePairingRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .use("/runtime-pairings/:pairingId/redeem", pairingTimeoutMiddleware("Runtime pairing redemption timed out"))
        .use("/projects/:projectId/runtime-pairings", pairingTimeoutMiddleware("Runtime pairing creation timed out"))
        .use(
            "/projects/:projectId/runtime-pairings/:pairingId",
            pairingTimeoutMiddleware("Runtime pairing lookup timed out"),
        )
        .use("/projects/:projectId/runtimes/:runtimeId", pairingTimeoutMiddleware("Runtime revocation timed out"))
        .post(
            "/runtime-pairings/:pairingId/redeem",
            bodyParser<RelayHttpEnvironment>([
                "agents",
                "installableAgents",
                "machineName",
                "pairingCode",
                "workspaceName",
            ]),
            async (context) => {
                const body = context.req.valid("json");
                const agents = validateAgents(body["agents"]);
                validateLegacyInstallableAgents(body["installableAgents"]);
                const redeemed = await context.env.services.runtimePairings.redeemRuntimePairing(
                    validateIdentifier(context.req.param("pairingId"), "pairing_id"),
                    validatePairingCode(body["pairingCode"]),
                    validateDisplayName(body["machineName"], "machine_name"),
                    validateDisplayName(body["workspaceName"], "workspace_name"),
                    agents,
                    context.var.signal,
                );
                return context.json({
                    appId: redeemed.appId,
                    channelId: redeemed.channelId,
                    runtimeCredential: redeemed.daemonToken,
                    runtimeId: redeemed.runtimeId,
                });
            },
        )
        .get("/runtimes/connect", async (context) => {
            const request = context.req.raw;
            const access = await context.env.services.channels.authorizeRuntime(bearerToken(request), request.signal);
            return await context.env.gateways.channelGateway.acceptDaemon(access, request, request.signal);
        })
        .post(
            "/projects/:projectId/runtime-pairings",
            bodyParser<RelayHttpEnvironment>(["idempotencyKey"]),
            async (context) => {
                const request = context.req.raw;
                const body = context.req.valid("json");
                return context.json(
                    await context.env.services.runtimePairings.createProjectRuntimePairing(
                        validateIdentifier(context.req.param("projectId"), "project_id"),
                        bearerToken(request),
                        validateIdentifier(readString(body, "idempotencyKey"), "idempotency_key"),
                        context.var.signal,
                    ),
                    201,
                );
            },
        )
        .get("/projects/:projectId/runtime-pairings/:pairingId", async (context) => {
            const request = context.req.raw;
            return context.json(
                await context.env.services.runtimePairings.readProjectRuntimePairing(
                    validateIdentifier(context.req.param("projectId"), "project_id"),
                    validateIdentifier(context.req.param("pairingId"), "pairing_id"),
                    bearerToken(request),
                    context.var.signal,
                ),
            );
        })
        .get("/projects/:projectId/runtimes/:runtimeId/host", async (context) => {
            const request = context.req.raw;
            const access = await context.env.services.runtimePairings.authorizeProjectRuntimeHost(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                context.req.query("token") ?? "",
                request.signal,
            );
            return await context.env.gateways.channelGateway.acceptHost(access, request, request.signal);
        })
        .delete("/projects/:projectId/runtimes/:runtimeId", async (context) => {
            const request = context.req.raw;
            await context.env.services.runtimePairings.revokeProjectRuntime(
                validateIdentifier(context.req.param("projectId"), "project_id"),
                validateIdentifier(context.req.param("runtimeId"), "runtime_id"),
                bearerToken(request),
                context.var.signal,
            );
            return new Response(null, { status: 204 });
        });
}
