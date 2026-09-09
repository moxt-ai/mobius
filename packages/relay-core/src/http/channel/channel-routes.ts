import { Hono } from "hono";
import {
    validateAgentCatalog,
    validateAgents,
    validateIdentifier,
    validateInstallableAgents,
} from "../../entity/pairing/pairing.ts";
import {
    assertExactKeys,
    bearerToken,
    directoryError,
    parseJsonBody,
    preserveCancellation,
    readString,
    sessionError,
} from "../../infra/relay-http.ts";
import type { RelayHttpEnvironment } from "../relay-http-environment.ts";

export function createChannelRoutes() {
    return new Hono<RelayHttpEnvironment>()
        .put("/:channelId/catalog", async (context) => {
            const useCases = context.env.services.channels;
            try {
                const body = await parseJsonBody(context.req.raw);
                assertExactKeys(body, ["agents", "installableAgents"]);
                const agents = validateAgents(body["agents"]);
                const installableAgents = validateInstallableAgents(body["installableAgents"]);
                validateAgentCatalog(agents, installableAgents);
                await useCases.updateAgentCatalog(
                    validateIdentifier(context.req.param("channelId"), "channel_id"),
                    context.req.query("token") ?? "",
                    agents,
                    installableAgents,
                    context.req.raw.signal,
                );
                return new Response(null, { status: 204 });
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        })
        .post("/:channelId/access-grants", async (context) => {
            const useCases = context.env.services.channels;
            try {
                return context.json(
                    await useCases.createAccessGrant(
                        validateIdentifier(context.req.param("channelId"), "channel_id"),
                        bearerToken(context.req.raw),
                        context.req.raw.signal,
                    ),
                    201,
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        })
        .post("/:channelId/access-grants/:grantId/redeem", async (context) => {
            const useCases = context.env.services.channels;
            try {
                const body = await parseJsonBody(context.req.raw);
                assertExactKeys(body, ["grantSecret"]);
                return context.json(
                    await useCases.redeemAccessGrant(
                        validateIdentifier(context.req.param("channelId"), "channel_id"),
                        validateIdentifier(context.req.param("grantId"), "grant_id"),
                        readString(body, "grantSecret", 256),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        })
        .get("/:channelId/linked-devices", async (context) => {
            const useCases = context.env.services.channels;
            try {
                return context.json({
                    devices: await useCases.listLinkedDevices(
                        validateIdentifier(context.req.param("channelId"), "channel_id"),
                        bearerToken(context.req.raw),
                        context.req.raw.signal,
                    ),
                });
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        })
        .delete("/:channelId/linked-devices/:credentialId", async (context) => {
            const useCases = context.env.services.channels;
            try {
                await useCases.revokeLinkedDevice(
                    validateIdentifier(context.req.param("channelId"), "channel_id"),
                    validateIdentifier(context.req.param("credentialId"), "credential_id"),
                    bearerToken(context.req.raw),
                    context.req.raw.signal,
                );
                return new Response(null, { status: 204 });
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        })
        .get("/:channelId", async (context) => {
            const useCases = context.env.services.channels;
            try {
                return context.json(
                    await useCases.readChannel(
                        validateIdentifier(context.req.param("channelId"), "channel_id"),
                        context.req.query("token") ?? bearerToken(context.req.raw),
                        context.req.raw.signal,
                    ),
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        })
        .get("/:channelId/host", async (context) => {
            const useCases = context.env.services.channels;
            try {
                return await useCases.acceptHost(
                    validateIdentifier(context.req.param("channelId"), "channel_id"),
                    context.req.query("token") ?? "",
                    context.req.raw,
                    context.req.raw.signal,
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        })
        .get("/:channelId/sessions/:sessionId/commands/:commandId/artifacts/:artifactId/content", async (context) => {
            const useCases = context.env.services.channels;
            try {
                const content = await useCases.readArtifactContent(
                    validateIdentifier(context.req.param("channelId"), "channel_id"),
                    context.req.query("token") ?? "",
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
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return sessionError(error);
            }
        })
        .get("/:channelId/daemon", async (context) => {
            const useCases = context.env.services.channels;
            try {
                return await useCases.acceptDaemon(
                    validateIdentifier(context.req.param("channelId"), "channel_id"),
                    context.req.query("token") ?? "",
                    context.req.raw,
                    context.req.raw.signal,
                );
            } catch (error) {
                preserveCancellation(context.req.raw.signal, error);
                return directoryError(error);
            }
        });
}
