import { Hono } from "hono";
import {
    assertExactKeys,
    bearerToken,
    directoryError,
    parseJsonBody,
    preserveCancellation,
    readString,
    sessionError,
} from "../../infra/relay-http.ts";
import type { ChannelService } from "../../service/channel/channel-service.ts";
import {
    validateAgentCatalog,
    validateAgents,
    validateIdentifier,
    validateInstallableAgents,
} from "../../service/pairing/pairing.ts";

export class ChannelController {
    static readonly inject = ["channels"] satisfies readonly ["channels"];
    readonly routes: Hono;
    constructor(useCases: ChannelService) {
        const app = new Hono();

        app.put("/:channelId/catalog", async (context) => {
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
        });

        app.post("/:channelId/access-grants", async (context) => {
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
        });

        app.post("/:channelId/access-grants/:grantId/redeem", async (context) => {
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
        });

        app.get("/:channelId/linked-devices", async (context) => {
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
        });

        app.delete("/:channelId/linked-devices/:credentialId", async (context) => {
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
        });

        app.get("/:channelId", async (context) => {
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
        });

        app.get("/:channelId/host", async (context) => {
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
        });

        app.get(
            "/:channelId/sessions/:sessionId/commands/:commandId/artifacts/:artifactId/content",
            async (context) => {
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
            },
        );

        app.get("/:channelId/daemon", async (context) => {
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

        this.routes = app;
    }
}
