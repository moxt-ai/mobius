import { Hono } from "hono";
import { ProjectScope } from "../../entity/do/session.ts";
import type { RuntimeService } from "../../service/channel/runtime-service.ts";

function unauthorized(message: string): Response {
    return Response.json({ error: { code: "unauthorized", message } }, { status: 401 });
}

export function createRuntimeRoutes(runtime: RuntimeService) {
    return new Hono().all("/projects/:projectId/*", async (c) => {
        const request = c.req.raw;
        const channelId = request.headers.get("x-mobius-channel-id");
        const runtimeId = request.headers.get("x-mobius-runtime-id");
        const projectId = c.req.param("projectId");
        if (channelId === null || runtimeId === null || projectId === null) {
            return unauthorized("Verified channel access is required");
        }
        const scope = new ProjectScope(projectId);
        const url = new URL(request.url);
        const credentialId = request.headers.get("x-mobius-host-credential-id");
        if (request.method === "DELETE" && url.pathname.endsWith("/runtime/revoke")) {
            await runtime.revokeRuntime(channelId, runtimeId, scope, request.signal);
            return new Response(null, { status: 204 });
        }
        if (request.method === "DELETE" && url.pathname.endsWith("/host-credentials/revoke")) {
            if (credentialId === null) {
                return unauthorized("Verified host credential access is required");
            }
            runtime.revokeHost(channelId, credentialId, runtimeId, scope);
            return new Response(null, { status: 204 });
        }
        if (request.method === "POST" && url.pathname.endsWith("/pending-daemon-deliveries")) {
            await runtime.dispatchPending(runtimeId, scope, request.signal);
            return new Response(null, { status: 204 });
        }
        if (request.method === "GET" && url.pathname.endsWith("/runtime-status")) {
            return Response.json({ online: runtime.isOnline(runtimeId) });
        }
        const revoked = () =>
            Response.json(
                { error: { code: "runtime_revoked", message: "The Runtime has been revoked" } },
                { status: 401 },
            );
        if (runtime.isRevoked(runtimeId, scope)) {
            return revoked();
        }
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("WebSocket upgrade required", { status: 426 });
        }
        if (url.pathname.endsWith("/daemon")) {
            const result = await runtime.acceptDaemon(
                runtimeId,
                scope,
                url.searchParams.get("liveness") === "1",
                url.searchParams.get("deliveryReceipts") === "1",
                request.signal,
            );
            switch (result.kind) {
                case "accepted":
                    return result.response;
                case "revoked":
                    return revoked();
                case "conflict":
                    return Response.json(
                        {
                            error: {
                                code: "runtime_identity_conflict",
                                message: "The Channel is already assigned to another Runtime",
                            },
                        },
                        { status: 409 },
                    );
            }
            const unreachable: never = result;
            return unreachable;
        }
        if (url.pathname.endsWith("/host")) {
            if (credentialId === null) {
                return unauthorized("Verified host credential access is required");
            }
            return runtime.acceptHost(
                {
                    role: "host",
                    channelId,
                    credentialId,
                    runtimeId,
                    projectId,
                },
                request.signal,
            );
        }
        if (url.pathname.endsWith("/live-history")) {
            return runtime.acceptRelay({ role: "relay", channelId, runtimeId, projectId }, request.signal);
        }
        return new Response(null, { status: 404 });
    });
}
