import { Hono } from "hono";
import {
    validateAgentCatalog,
    validateAgents,
    validateIdentifier,
    validateInstallableAgents,
} from "../../entity/pairing/pairing.ts";
import { bearerToken, readString } from "../../infra/relay-http.ts";
import { bodyParser } from "../middleware/body-parser.ts";
import { rethrowHonoError } from "../middleware/error-response-middleware.ts";
import { directoryErrorMiddleware, sessionErrorMiddleware } from "../middleware/relay-error-middleware.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

export function createChannelRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .onError(rethrowHonoError)
        .use("*", directoryErrorMiddleware)
        .use(
            "/:channelId/sessions/:sessionId/commands/:commandId/artifacts/:artifactId/content",
            sessionErrorMiddleware,
        )
        .put(
            "/:channelId/catalog",
            bodyParser<RelayHttpEnvironment>(["agents", "installableAgents"]),
            async (context) => {
                const useCases = context.env.services.channels;
                const body = context.req.valid("json");
                const agents = validateAgents(body["agents"]);
                const installableAgents = validateInstallableAgents(body["installableAgents"]);
                validateAgentCatalog(agents, installableAgents);
                await useCases.updateAgentCatalog(
                    validateIdentifier(context.req.param("channelId"), "channel_id"),
                    context.req.query("token") ?? bearerToken(context.req.raw),
                    agents,
                    installableAgents,
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
            return await useCases.acceptHost(
                validateIdentifier(context.req.param("channelId"), "channel_id"),
                context.req.query("token") ?? "",
                context.req.raw,
                context.req.raw.signal,
            );
        })
        .get("/:channelId/sessions/:sessionId/commands/:commandId/artifacts/:artifactId/content", async (context) => {
            const useCases = context.env.services.channels;
            const content = await useCases.readArtifactContent(
                validateIdentifier(context.req.param("channelId"), "channel_id"),
                context.req.query("token") ?? bearerToken(context.req.raw),
                validateIdentifier(context.req.param("sessionId"), "session_id"),
                validateIdentifier(context.req.param("commandId"), "command_id"),
                validateIdentifier(context.req.param("artifactId"), "artifact_id"),
                context.req.raw.signal,
            );
            return new Response(Uint8Array.from(content.bytes), {
                headers: {
                    "content-length": content.bytes.byteLength.toString(),
                    "content-type": content.artifact.mediaType,
                    "x-mobius-artifact-id": content.artifact.artifactId,
                    "x-mobius-sha256": content.artifact.sha256,
                },
            });
        })
        .get("/:channelId/daemon", async (context) => {
            const useCases = context.env.services.channels;
            return await useCases.acceptDaemon(
                validateIdentifier(context.req.param("channelId"), "channel_id"),
                context.req.query("token") ?? bearerToken(context.req.raw),
                context.req.raw,
                context.req.raw.signal,
            );
        });
}
