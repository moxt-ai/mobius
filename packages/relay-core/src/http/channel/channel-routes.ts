import { Hono } from "hono";
import { validateAgents, validateIdentifier, validateLegacyInstallableAgents } from "../../entity/pairing/pairing.ts";
import { bearerToken, readString } from "../../infra/relay-http.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { errorMiddleware, rethrowHonoError } from "../middleware/error-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

export function createChannelRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", errorMiddleware)
        .put(
            "/:channelId/catalog",
            bodyParser<RelayHttpEnvironment>(["agents", "installableAgents"]),
            async (context) => {
                const useCases = context.env.services.channels;
                const body = context.req.valid("json");
                const agents = validateAgents(body["agents"]);
                validateLegacyInstallableAgents(body["installableAgents"]);
                await useCases.updateAgentCatalog(
                    validateIdentifier(context.req.param("channelId"), "channel_id"),
                    context.req.query("token") ?? bearerToken(context.req.raw),
                    agents,
                    context.req.raw.signal,
                );
                return new Response(null, { status: 204 });
            },
        )
        .post("/:channelId/access-grants", async (context) => {
            const useCases = context.env.services.channels;
            return context.json(
                await useCases.createAccessGrant(
                    validateIdentifier(context.req.param("channelId"), "channel_id"),
                    bearerToken(context.req.raw),
                    context.req.raw.signal,
                ),
                201,
            );
        })
        .post(
            "/:channelId/access-grants/:grantId/redeem",
            bodyParser<RelayHttpEnvironment>(["grantSecret"]),
            async (context) => {
                const useCases = context.env.services.channels;
                const body = context.req.valid("json");
                return context.json(
                    await useCases.redeemAccessGrant(
                        validateIdentifier(context.req.param("channelId"), "channel_id"),
                        validateIdentifier(context.req.param("grantId"), "grant_id"),
                        readString(body, "grantSecret", 256),
                        context.req.raw.signal,
                    ),
                );
            },
        )
        .get("/:channelId/linked-devices", async (context) => {
            const useCases = context.env.services.channels;
            return context.json({
                devices: await useCases.listLinkedDevices(
                    validateIdentifier(context.req.param("channelId"), "channel_id"),
                    bearerToken(context.req.raw),
                    context.req.raw.signal,
                ),
            });
        })
        .delete("/:channelId/linked-devices/:credentialId", async (context) => {
            const useCases = context.env.services.channels;
            await useCases.revokeLinkedDevice(
                validateIdentifier(context.req.param("channelId"), "channel_id"),
                validateIdentifier(context.req.param("credentialId"), "credential_id"),
                bearerToken(context.req.raw),
                context.req.raw.signal,
            );
            return new Response(null, { status: 204 });
        })
        .get("/:channelId", async (context) => {
            const useCases = context.env.services.channels;
            return context.json(
                await useCases.readChannel(
                    validateIdentifier(context.req.param("channelId"), "channel_id"),
                    context.req.query("token") ?? bearerToken(context.req.raw),
                    context.req.raw.signal,
                ),
            );
        })
        .get("/:channelId/host", async (context) => {
            const useCases = context.env.services.channels;
            const request = context.req.raw;
            const access = await useCases.authorizeHost(
                validateIdentifier(context.req.param("channelId"), "channel_id"),
                context.req.query("token") ?? "",
                request.signal,
            );
            return await context.env.gateways.channelGateway.acceptHost(access, request, request.signal);
        })
        .get("/:channelId/daemon", async (context) => {
            const useCases = context.env.services.channels;
            const request = context.req.raw;
            const access = await useCases.authorizeDaemon(
                validateIdentifier(context.req.param("channelId"), "channel_id"),
                context.req.query("token") ?? bearerToken(request),
                request.signal,
            );
            return await context.env.gateways.channelGateway.acceptDaemon(access, request, request.signal);
        });
}
