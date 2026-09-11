import { SELF } from "cloudflare:test";
import {
    AGENT_MESSAGE_DELTA_KIND,
    BotExecutionBindingApprovedEvent,
    decodeBotExecutionBindingApprovalRequest,
    decodeBotSessionPromptCommand,
    decodeSessionConfigureCommand,
    decodeSessionEventAcknowledgement,
    encodeBotExecutionBindingApprovedEvent,
    encodeSessionConfigUpdatedEvent,
    encodeSessionEventEnvelope,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_STARTED_KIND,
    type SessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import {
    createMobiusConversationSession,
    MobiusArtifactUploadRequest,
    MobiusBrowserAccessToken,
    MobiusPageRequest,
} from "@moxt-ai/mobius-sdk/browser";
import type { MobiusHttpTransport } from "@moxt-ai/mobius-sdk/server";
import { expect, it } from "vitest";
import { DemoPlatformService } from "../src/demo-platform-service.ts";

const endpoint = "https://platform-demo.test";

class PlatformWorkerTransport implements MobiusHttpTransport {
    readonly fetch = async (request: Request): Promise<Response> => await SELF.fetch(request);
}

class SocketMessages {
    readonly #messages: string[] = [];
    readonly #resolvers: Array<(message: string) => void> = [];

    constructor(socket: WebSocket) {
        socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
                throw new Error("Expected a text WebSocket message");
            }
            const resolve = this.#resolvers.shift();
            if (resolve === undefined) {
                this.#messages.push(event.data);
            } else {
                resolve(event.data);
            }
        });
    }

    readonly next = (): Promise<string> => {
        const message = this.#messages.shift();
        return message === undefined
            ? new Promise((resolve) => this.#resolvers.push(resolve))
            : Promise.resolve(message);
    };
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a response object");
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function responseText(value: Readonly<Record<string, unknown>>, field: string): string {
    const candidate = value[field];
    if (typeof candidate !== "string" || candidate.length === 0) {
        throw new Error(`Expected ${field}`);
    }
    return candidate;
}

async function commitRuntimeEvent(
    socket: WebSocket,
    messages: SocketMessages,
    event: SessionEventEnvelope,
): Promise<void> {
    socket.send(encodeSessionEventEnvelope(event));
    expect(decodeSessionEventAcknowledgement(await messages.next())).toMatchObject({
        duplicate: false,
        eventId: event.eventId,
        sessionId: event.sessionId,
    });
}

const readyAgents = [
    {
        agentPath: "/usr/local/bin/codex",
        agentVersion: "codex 1.0.0",
        capabilities: {
            additionalDirectories: true,
            audioPrompt: false,
            closeSession: true,
            deleteSession: true,
            embeddedContextPrompt: true,
            imagePrompt: true,
            listSessions: true,
            loadSession: true,
            promptQueueing: false,
            resumeSession: true,
            steering: false,
            unstableForkSession: false,
        },
        id: "codex",
        label: "Codex",
    },
];

it("Given a clean local Platform, When an operator provisions the demo, Then the browser receives health, resources, usage, and audit evidence without an AppCredential", async () => {
    const service = new DemoPlatformService({
        authenticationProviderId: "demo-local",
        developerCredential: "developer-token-developer-token-32",
        endpoint,
        transport: new PlatformWorkerTransport(),
    });

    const snapshot = await service.provision("Acceptance", AbortSignal.timeout(5_000));

    expect(snapshot.health).toBe("ok");
    expect(snapshot.configuration).toMatchObject({ anonymousPublicBootstrap: false, hostingProfile: "platform" });
    expect(snapshot.tenant.tenantId).toMatch(/^ten_/);
    expect(snapshot.app.appId).toMatch(/^app_/);
    expect(snapshot.project.projectId).toMatch(/^prj_/);
    expect(snapshot.usage).toMatchObject({ activeApps: 1, activeProjects: 1, tenantId: snapshot.tenant.tenantId });
    expect(snapshot.auditEvents.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(snapshot)).not.toContain("mapp_");
    expect(Object.hasOwn(snapshot, "appCredential")).toBe(false);
});

it("Given a provisioned demo Project, When an operator verifies AppCredential rotation and revocation, Then the scoped server access works and no credential secret enters the report", async () => {
    const service = new DemoPlatformService({
        authenticationProviderId: "demo-local",
        developerCredential: "developer-token-developer-token-32",
        endpoint,
        transport: new PlatformWorkerTransport(),
    });
    await service.provision("Credential acceptance", AbortSignal.timeout(5_000));

    const report = await service.verifyAppCredentialLifecycle(AbortSignal.timeout(5_000));

    expect(report.issuedCredentialId).toMatch(/^pac_/);
    expect(report.rotatedCredentialId).toMatch(/^pac_/);
    expect(report.rotatedCredentialId).not.toBe(report.issuedCredentialId);
    expect(report.revokedCredentialId).toBe(report.rotatedCredentialId);
    expect(report.scopeProjectCount).toBe(1);
    expect(report.revokedAccessDenied).toBe(true);
    expect(JSON.stringify(report)).not.toContain("mapp_");
});

it("Given a provisioned demo Project, When a Runtime pairing is redeemed, Then the backend observes the paired Runtime without receiving its credential", async () => {
    const transport = new PlatformWorkerTransport();
    const service = new DemoPlatformService({
        authenticationProviderId: "demo-local",
        developerCredential: "developer-token-developer-token-32",
        endpoint,
        transport,
    });
    await service.provision("Runtime acceptance", AbortSignal.timeout(5_000));
    const pairing = await service.createRuntimePairing(AbortSignal.timeout(5_000));

    expect((await service.readRuntimePairing(AbortSignal.timeout(5_000))).status).toBe("pending");
    const redeemed = await transport.fetch(
        new Request(`${endpoint}/mobius/api/v1/runtime-pairings/${pairing.pairingId}/redeem`, {
            body: JSON.stringify({
                agents: readyAgents,
                installableAgents: [],
                machineName: "Acceptance Runtime",
                pairingCode: pairing.pairingCode,
                workspaceName: "acceptance-workspace",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );
    expect(redeemed.status).toBe(200);

    const report = await service.readRuntimePairing(AbortSignal.timeout(5_000));

    expect(report.status).toBe("paired");
    expect(report.runtimeId).toBe(pairing.runtimeId);
    expect(report.machineName).toBe("Acceptance Runtime");
    expect(report.agentLabels).toEqual(["Codex"]);
    expect(JSON.stringify(report)).not.toContain("runtimeCredential");
    expect(JSON.stringify(report)).not.toContain("daemonToken");
});

it("Given an online demo Runtime, When an operator creates a Bot and Conversation, Then the Runtime approves its binding and a browser receives only fixed-session access", async () => {
    const transport = new PlatformWorkerTransport();
    const service = new DemoPlatformService({
        authenticationProviderId: "demo-local",
        developerCredential: "developer-token-developer-token-32",
        endpoint,
        transport,
    });
    await service.provision("Conversation acceptance", AbortSignal.timeout(5_000));
    const pairing = await service.createRuntimePairing(AbortSignal.timeout(5_000));
    const redeemedResponse = await transport.fetch(
        new Request(`${endpoint}/mobius/api/v1/runtime-pairings/${pairing.pairingId}/redeem`, {
            body: JSON.stringify({
                agents: readyAgents,
                installableAgents: [],
                machineName: "Conversation Runtime",
                pairingCode: pairing.pairingCode,
                workspaceName: "conversation-workspace",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );
    const redeemed = responseRecord(await redeemedResponse.json());
    const runtimeResponse = await transport.fetch(
        new Request(`${endpoint}/mobius/api/v1/runtimes/connect`, {
            headers: {
                authorization: `Bearer ${responseText(redeemed, "runtimeCredential")}`,
                upgrade: "websocket",
            },
        }),
    );
    expect(runtimeResponse.status).toBe(101);
    const socket = runtimeResponse.webSocket;
    if (socket === null) {
        throw new Error("Expected a Runtime WebSocket");
    }
    const messages = new SocketMessages(socket);
    socket.accept();
    try {
        const bot = await service.createBot(AbortSignal.timeout(5_000));
        const approval = decodeBotExecutionBindingApprovalRequest(await messages.next());
        const approved = new BotExecutionBindingApprovedEvent(
            approval.requestId,
            approval.botId,
            approval.behaviorRevisionId,
            approval.bindingId,
            approval.bindingRevision,
            `grant_${bot.botId}`,
            "a".repeat(64),
            "b".repeat(64),
        );
        socket.send(encodeBotExecutionBindingApprovedEvent(approved));
        expect(await messages.next()).toBe(encodeBotExecutionBindingApprovedEvent(approved));

        const access = await service.createConversationAccess(AbortSignal.timeout(5_000));
        const browser = createMobiusConversationSession({
            accessTokenProvider: {
                accessToken: async () => new MobiusBrowserAccessToken(access.credential, access.expiresAt),
            },
            endpoint,
            transport,
        });
        const snapshot = await browser.session.read(AbortSignal.timeout(5_000));

        expect(bot.bindingStatus).toBe("requested");
        expect(access.conversationId).toBe(snapshot.access.conversationId);
        expect(access.sessionId).toBe(snapshot.session.sessionId);
        expect(snapshot.access.permissions).toContain("conversation:read");
        expect(JSON.stringify(access)).not.toContain("mapp_");
        expect("projects" in browser).toBe(false);
        expect("runtimePairings" in browser).toBe(false);
        browser.close();
    } finally {
        socket.close(1000, "Demo Bot acceptance complete");
    }
});

it("Given a fixed demo Conversation, When a browser configures, uploads, messages, runs, and reads it, Then the complete browser data plane remains usable", async () => {
    const transport = new PlatformWorkerTransport();
    const service = new DemoPlatformService({
        authenticationProviderId: "demo-local",
        developerCredential: "developer-token-developer-token-32",
        endpoint,
        transport,
    });
    await service.provision("Browser data acceptance", AbortSignal.timeout(5_000));
    const pairing = await service.createRuntimePairing(AbortSignal.timeout(5_000));
    const redeemedResponse = await transport.fetch(
        new Request(`${endpoint}/mobius/api/v1/runtime-pairings/${pairing.pairingId}/redeem`, {
            body: JSON.stringify({
                agents: readyAgents,
                installableAgents: [],
                machineName: "Browser Data Runtime",
                pairingCode: pairing.pairingCode,
                workspaceName: "browser-data-workspace",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );
    const redeemed = responseRecord(await redeemedResponse.json());
    const runtimeResponse = await transport.fetch(
        new Request(`${endpoint}/mobius/api/v1/runtimes/connect`, {
            headers: {
                authorization: `Bearer ${responseText(redeemed, "runtimeCredential")}`,
                upgrade: "websocket",
            },
        }),
    );
    const socket = runtimeResponse.webSocket;
    if (socket === null) {
        throw new Error("Expected a Runtime WebSocket");
    }
    const messages = new SocketMessages(socket);
    socket.accept();
    try {
        const bot = await service.createBot(AbortSignal.timeout(5_000));
        const approval = decodeBotExecutionBindingApprovalRequest(await messages.next());
        const approved = new BotExecutionBindingApprovedEvent(
            approval.requestId,
            approval.botId,
            approval.behaviorRevisionId,
            approval.bindingId,
            approval.bindingRevision,
            `grant_${bot.botId}`,
            "a".repeat(64),
            "b".repeat(64),
        );
        socket.send(encodeBotExecutionBindingApprovedEvent(approved));
        await messages.next();
        const access = await service.createConversationAccess(AbortSignal.timeout(5_000));
        const browser = createMobiusConversationSession({
            accessTokenProvider: {
                accessToken: async () => new MobiusBrowserAccessToken(access.credential, access.expiresAt),
            },
            endpoint,
            transport,
        });

        expect((await browser.configuration.read(AbortSignal.timeout(5_000))).revision).toBe(1);
        const configuration = await browser.configuration.update(
            {
                additionalDirectoryIds: [],
                booleanValue: false,
                configId: "model",
                idempotencyKey: "demo-config-model",
                value: "verified-model",
                valueType: "select",
            },
            AbortSignal.timeout(5_000),
        );
        const configureCommand = decodeSessionConfigureCommand(await messages.next());
        await commitRuntimeEvent(socket, messages, {
            eventId: "demo-config-updated",
            kind: SESSION_EVENT_KIND,
            payload: encodeSessionConfigUpdatedEvent({
                configOptions: [
                    {
                        booleanValue: false,
                        category: "model",
                        currentValue: "verified-model",
                        description: "Model selected by the Platform demo",
                        id: "model",
                        name: "Model",
                        type: "select",
                        values: [
                            {
                                description: "Verified demo model",
                                groupId: "",
                                groupName: "",
                                name: "Verified model",
                                value: "verified-model",
                            },
                        ],
                    },
                ],
                kind: "session.config.updated",
                requestId: configureCommand.requestId,
                sessionId: access.sessionId,
            }),
            sessionId: access.sessionId,
            source: { kind: "runtime", sourceSeq: "1" },
        });
        expect(configuration.status).toBe("accepted");
        expect((await browser.configuration.read(AbortSignal.timeout(5_000))).revision).toBe(2);

        const bytes = new TextEncoder().encode("Mobius Platform artifact round trip");
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
            byte.toString(16).padStart(2, "0"),
        ).join("");
        const upload = await browser.artifacts.createUpload(
            new MobiusArtifactUploadRequest("evidence.txt", "text/plain", bytes.byteLength, digest),
            AbortSignal.timeout(5_000),
        );
        const available = await browser.artifacts.uploadContent(upload, bytes, AbortSignal.timeout(5_000));
        expect((await browser.artifacts.read(available.artifactId, AbortSignal.timeout(5_000))).state).toBe(
            "available",
        );
        expect(
            new TextDecoder().decode(
                (await browser.artifacts.download(available.artifactId, AbortSignal.timeout(5_000))).bytes,
            ),
        ).toBe("Mobius Platform artifact round trip");

        const accepted = await browser.messages.create(
            {
                artifactIds: [available.artifactId],
                content: "Verify this Platform conversation",
                idempotencyKey: "demo-browser-message",
                images: [],
                resources: [],
            },
            AbortSignal.timeout(5_000),
        );
        expect(
            (await browser.history.read(new MobiusPageRequest(20, ""), AbortSignal.timeout(5_000))).acceptedMessages,
        ).toMatchObject([{ messageId: accepted.messageId }]);
        const submitted = await browser.messages.run(accepted.messageId, AbortSignal.timeout(5_000));
        const prompt = decodeBotSessionPromptCommand(await messages.next());
        const attemptId = "demo-browser-attempt";
        await commitRuntimeEvent(socket, messages, {
            eventId: "demo-browser-started",
            kind: SESSION_EVENT_KIND,
            payload: JSON.stringify({
                attemptId,
                commandId: prompt.commandId,
                kind: SESSION_STARTED_KIND,
                sessionId: access.sessionId,
            }),
            sessionId: access.sessionId,
            source: { attemptId, kind: "attempt", sourceSeq: "1" },
        });
        await commitRuntimeEvent(socket, messages, {
            eventId: "demo-browser-delta",
            kind: SESSION_EVENT_KIND,
            payload: JSON.stringify({
                commandId: prompt.commandId,
                kind: AGENT_MESSAGE_DELTA_KIND,
                messageId: "",
                sessionId: access.sessionId,
                text: "Verified through Mobius Platform.",
            }),
            sessionId: access.sessionId,
            source: { attemptId, kind: "attempt", sourceSeq: "2" },
        });
        await commitRuntimeEvent(socket, messages, {
            eventId: "demo-browser-completed",
            kind: SESSION_EVENT_KIND,
            payload: JSON.stringify({
                commandId: prompt.commandId,
                kind: SESSION_COMPLETED_KIND,
                sessionId: access.sessionId,
                stopReason: "end_turn",
            }),
            sessionId: access.sessionId,
            source: { attemptId, kind: "attempt", sourceSeq: "3" },
        });

        expect((await browser.turns.read(submitted.turnId, AbortSignal.timeout(5_000))).state.kind).toBe("succeeded");
        expect(
            (await browser.readEvents(new MobiusPageRequest(20, ""), AbortSignal.timeout(5_000))).events.length,
        ).toBe(4);
        expect(
            (await browser.session.readMessages(new MobiusPageRequest(20, ""), AbortSignal.timeout(5_000))).messages,
        ).toEqual(expect.arrayContaining([expect.objectContaining({ response: "Verified through Mobius Platform." })]));
        expect(await browser.interactions.listPending(AbortSignal.timeout(5_000))).toEqual([]);
        browser.close();
    } finally {
        socket.close(1000, "Demo browser data acceptance complete");
    }
});
