// @vitest-environment node

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createMobiusBotConnectorClient,
    redeemMobiusBotConnectionGrant,
    StaticMobiusCredentialProvider,
} from "../src/index.ts";

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        const fail = (error: Error): void => reject(error);
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", fail);
            resolve();
        });
    });
}

function port(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("The fake Bot API did not bind to a TCP port");
    }
    return address.port;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a JSON object");
    }
    return Object.fromEntries(Object.entries(value));
}

async function requestBody(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
    let encoded = "";
    for await (const chunk of request) {
        encoded += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    }
    return record(JSON.parse(encoded));
}

function respond(response: ServerResponse, status: number, value: object): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error === undefined) {
                resolve();
                return;
            }
            reject(error);
        });
    });
}

describe("provider-neutral Bot connector client", () => {
    afterEach(() => vi.useRealTimers());

    it("Given a one-time grant, When a stateful connector exchanges inbound and outbound work, Then the v1 client preserves credentials, cursors, claims, and Bot identity", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-08T09:00:00.000Z"));
        const requests: Readonly<Record<string, unknown>>[] = [];
        const server = createServer((request, response) => {
            void (async () => {
                const path = new URL(request.url ?? "/", "http://localhost");
                const body = request.method === "POST" ? await requestBody(request) : {};
                requests.push({
                    authorization: request.headers.authorization ?? "",
                    body,
                    method: request.method ?? "",
                    path: `${path.pathname}${path.search}`,
                });
                if (path.pathname.endsWith("/v1/bot-connection-grants/redeem")) {
                    respond(response, 201, {
                        audience: "mobius-cloud",
                        botId: "bot_alpha",
                        connectionId: "bcn_alpha",
                        connectorPrincipalId: "connector_alpha",
                        credential: "c".repeat(43),
                        credentialExpiresAt: "2026-10-08T09:00:00.000Z",
                        credentialId: "bcc_alpha",
                        label: "Production Slack",
                        lifecycle: "active",
                        lifecycleRevision: 1,
                        projectId: "prj_alpha",
                        scopes: [
                            "inbound-conversation:create",
                            "inbound-message:create",
                            "conversation-events:read",
                            "outbound-message:read",
                            "outbound-message:ack",
                        ],
                    });
                    return;
                }
                if (path.pathname.endsWith("/delivery-targets")) {
                    respond(response, 201, {
                        alias: "current",
                        botId: "bot_alpha",
                        connectionId: "bcn_alpha",
                        createdAt: "2026-09-08T09:00:00.000Z",
                        deliveryTargetId: "bdt_current",
                        lifecycle: "active",
                        lifecycleRevision: 1,
                        outboundPolicyRevision: 0,
                        ownerApproved: false,
                    });
                    return;
                }
                if (path.pathname.endsWith("/conversations")) {
                    respond(response, 201, {
                        behaviorRevisionId: "bbr_1",
                        bindingId: "beb_1",
                        bindingRevision: 1,
                        botId: "bot_alpha",
                        clientConversationKey: "external-thread-1",
                        connectionId: "bcn_alpha",
                        conversationId: "bcv_1",
                        createdAt: "2026-09-08T09:00:00.000Z",
                        creatorKind: "connection",
                        creatorPrincipalId: "connector_alpha",
                        lifecycle: "active",
                        replyDeliveryTargetId: "bdt_current",
                        sessionId: "ses_1",
                        title: "External thread",
                    });
                    return;
                }
                if (path.pathname.endsWith("/messages")) {
                    respond(response, 202, {
                        duplicate: false,
                        eventCursor: "cursor-0",
                        executionId: "exe_1",
                        turnId: "turn_1",
                    });
                    return;
                }
                if (path.pathname.endsWith("/events")) {
                    respond(response, 200, {
                        cursor: "cursor-2",
                        events: [
                            {
                                behaviorRevisionId: "bbr_1",
                                conversationId: "bcv_1",
                                eventId: "event_2",
                                kind: "session.completed",
                                payload: { kind: "session.completed", stopReason: "end_turn" },
                                sequence: "2",
                                timestamp: "2026-09-08T09:00:02.000Z",
                                turnId: "turn_1",
                            },
                        ],
                        hasMore: false,
                    });
                    return;
                }
                if (path.pathname.endsWith("/outbound-events")) {
                    respond(response, 200, {
                        cursor: 7,
                        events: [
                            {
                                acceptedAt: "2026-09-08T09:00:02.000Z",
                                behaviorRevisionId: "bbr_1",
                                bindingId: "beb_1",
                                bindingRevision: 1,
                                botId: "bot_alpha",
                                claimDeadlineAt: "2026-09-08T09:01:02.000Z",
                                claimId: "clm_1",
                                conversationId: "bcv_1",
                                deliveryTargetId: "bdt_current",
                                eventId: "outbound:out_1",
                                executionId: "exe_1",
                                expiresAt: "2026-09-15T09:00:02.000Z",
                                idempotencyKey: "completion:turn_1",
                                outboundMessageId: "out_1",
                                sequence: 7,
                                text: "Completed",
                                timestamp: "2026-09-08T09:00:02.000Z",
                                turnId: "turn_1",
                            },
                        ],
                    });
                    return;
                }
                if (path.pathname.endsWith("/delivered")) {
                    respond(response, 200, { duplicate: false, outboundMessageId: "out_1", state: "delivered" });
                    return;
                }
                respond(response, 404, { error: { code: "not_found", message: "Not found" } });
            })().catch((error) => {
                respond(response, 500, { error: { code: "fake_failure", message: String(error) } });
            });
        });
        await listen(server);
        const signal = new AbortController().signal;
        try {
            const endpoint = `http://127.0.0.1:${port(server).toString()}`;
            const redeemed = await redeemMobiusBotConnectionGrant(
                { endpoint },
                {
                    audience: "mobius-cloud",
                    connectorPrincipalId: "connector_alpha",
                    grantId: "bcg_alpha",
                    grantSecret: "g".repeat(43),
                },
                signal,
            );
            const client = createMobiusBotConnectorClient({
                connectionId: redeemed.connectionId,
                credentialProvider: new StaticMobiusCredentialProvider(redeemed.credential),
                endpoint,
                projectId: redeemed.projectId,
            });
            const target = await client.deliveryTargets.create({ alias: "current" }, signal);
            const conversation = await client.conversations.create(
                redeemed.botId,
                {
                    clientConversationKey: "external-thread-1",
                    replyDeliveryTargetId: target.deliveryTargetId,
                    title: "External thread",
                },
                signal,
            );
            const turn = await client.conversations.submitMessage(
                redeemed.botId,
                conversation.conversationId,
                {
                    actorRef: "external-user-1",
                    clientMessageId: "external-message-1",
                    resourceRefs: [],
                    text: "Run the task",
                },
                signal,
            );
            const events = await client.conversations.readEvents(
                redeemed.botId,
                conversation.conversationId,
                turn.eventCursor,
                signal,
            );
            const outbound = await client.outboundMessages.read(0, 100, signal);
            const message = outbound.events[0];
            if (message === undefined) {
                throw new Error("Expected an outbound event");
            }
            const acknowledgement = await client.outboundMessages.delivered(
                message.outboundMessageId,
                message.claimId,
                signal,
            );

            expect(events.events[0]).toMatchObject({
                behaviorRevisionId: "bbr_1",
                conversationId: conversation.conversationId,
                turnId: turn.turnId,
            });
            expect(message).toMatchObject({
                botId: redeemed.botId,
                conversationId: conversation.conversationId,
                sequence: 7,
            });
            expect(acknowledgement).toMatchObject({ duplicate: false, state: "delivered" });
            expect(requests[0]).toMatchObject({
                authorization: "",
                path: "/mobius/api/v1/bot-connection-grants/redeem",
            });
            expect(
                requests.slice(1).every((request) => request["authorization"] === `Bearer ${redeemed.credential}`),
            ).toBe(true);
            expect(requests.map((request) => request["path"])).toEqual([
                "/mobius/api/v1/bot-connection-grants/redeem",
                "/mobius/api/v1/bot-connections/bcn_alpha/delivery-targets",
                "/mobius/api/v1/projects/prj_alpha/bots/bot_alpha/conversations",
                "/mobius/api/v1/projects/prj_alpha/bots/bot_alpha/conversations/bcv_1/messages",
                "/mobius/api/v1/projects/prj_alpha/bots/bot_alpha/conversations/bcv_1/events?after=cursor-0",
                "/mobius/api/v1/bot-connections/bcn_alpha/outbound-events?after=0&limit=100",
                "/mobius/api/v1/bot-connections/bcn_alpha/outbound-messages/out_1/delivered",
            ]);
        } finally {
            await close(server);
        }
    });
});
