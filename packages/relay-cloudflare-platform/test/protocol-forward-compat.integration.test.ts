import { env } from "cloudflare:workers";
import { decodeSessionEventEnvelopeV2, MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import { decodeMobiusChannelDescriptor } from "@moxt-ai/mobius-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClerk } from "../../test-support/src/clerk.ts";
import {
    createPlatformApplication,
    createPlatformGateways,
    PlatformAuthenticationConfiguration,
    type PlatformRelayBindings,
} from "../src/worker.ts";

const relayOrigin = "https://platform.test";

// A newer daemon's capabilities: one additional boolean the Relay does not know.
const capabilitiesWithFutureField = {
    additionalDirectories: true,
    audioPrompt: false,
    closeSession: true,
    deleteSession: true,
    embeddedContextPrompt: true,
    futureCapability: true,
    imagePrompt: true,
    listSessions: true,
    loadSession: true,
    promptQueueing: false,
    renameSession: false,
    resumeSession: true,
    steering: false,
    unstableForkSession: false,
};

const capabilitiesMissingLaterFields = {
    additionalDirectories: true,
    audioPrompt: false,
    closeSession: true,
    deleteSession: true,
    embeddedContextPrompt: true,
    imagePrompt: true,
    listSessions: true,
    loadSession: true,
    // promptQueueing, renameSession, steering and unstableForkSession were added
    // later; a payload from before they existed omits them.
};

const futureAgent = {
    agentPath: "/usr/local/bin/codex",
    agentVersion: "codex 2.0.0",
    capabilities: capabilitiesWithFutureField,
    id: "codex",
    label: "Codex",
    sessionTurnConfiguration: true,
};

const legacyAgent = {
    agentPath: "/usr/local/bin/codex",
    agentVersion: "codex 2.0.0",
    capabilities: capabilitiesMissingLaterFields,
    id: "codex",
    label: "Codex",
    sessionTurnConfiguration: true,
};

function bindings(): PlatformRelayBindings {
    return {
        APP_CREDENTIAL_CACHE: env.APP_CREDENTIAL_CACHE,
        MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY: env.MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY,
        PLATFORM_DIRECTORY_DATABASE: env.PLATFORM_DIRECTORY_DATABASE,
        PROJECT_RELAY: env.PROJECT_RELAY,
        R2_BUCKET_APAC: env.R2_BUCKET_APAC,
        R2_BUCKET_WNAM: env.R2_BUCKET_WNAM,
        RUNTIME_RELAY: env.RUNTIME_RELAY,
    };
}

function developerHeaders(clerk: FakeClerk, developerId = "developer-1"): Headers {
    return new Headers({
        authorization: `Bearer ${clerk.session(developerId, clerk.defaultOrganizationId)}`,
        "content-type": "application/json",
        "x-mobius-oidc-provider": "clerk",
    });
}

function credentialHeaders(credential: string): Headers {
    return new Headers({ authorization: `Bearer ${credential}`, "content-type": "application/json" });
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

async function responseJson(response: Response, expectedStatus: number): Promise<Record<string, unknown>> {
    const body = await response.json();
    expect(response.status).toBe(expectedStatus);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new Error("Expected a response object");
    }
    return body as Record<string, unknown>;
}

interface PairedRuntime {
    readonly appId: string;
    readonly appCredential: string;
    readonly projectId: string;
    readonly runtimeCredential: string;
    readonly runtimeId: string;
}

/**
 * Enters through the production HTTP pairing boundary with the given ready
 * agent directory, exactly as a newer daemon would during redemption.
 */
async function pairRuntime(
    application: ReturnType<typeof createPlatformApplication>,
    environment: PlatformRelayBindings,
    clerk: FakeClerk,
    agents: readonly unknown[],
): Promise<PairedRuntime> {
    const tenants = await responseJson(
        await application.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/platform/tenants`, {
                headers: developerHeaders(clerk),
            }),
            environment,
        ),
        200,
    );
    const tenantValues = tenants["tenants"];
    if (!Array.isArray(tenantValues) || tenantValues.length === 0) {
        throw new Error("Expected a Platform tenant");
    }
    const tenant = tenantValues[0] as Record<string, unknown>;
    const app = await responseJson(
        await application.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps`, {
                body: JSON.stringify({ displayName: "Forward compat", tenantId: tenant["tenantId"] }),
                headers: developerHeaders(clerk),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const defaultCredential = app["defaultCredential"] as Record<string, unknown> | undefined;
    if (defaultCredential === undefined) {
        throw new Error("Expected a default App credential");
    }
    const appCredential = defaultCredential["credential"];
    if (typeof appCredential !== "string") {
        throw new Error("Expected the default App credential token");
    }
    const project = await responseJson(
        await application.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/dashboard/v1/apps/${app["appId"]}/projects`, {
                body: JSON.stringify({
                    displayName: "Forward compat Project",
                    idempotencyKey: "forward-compat-project",
                    locationHint: "apac",
                }),
                headers: credentialHeaders(appCredential),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const projectId = project["projectId"];
    const pairing = await responseJson(
        await application.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtime-pairings`, {
                body: JSON.stringify({ idempotencyKey: "forward-compat-runtime" }),
                headers: credentialHeaders(appCredential),
                method: "POST",
            }),
            environment,
        ),
        201,
    );
    const claimed = await responseJson(
        await application.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtime-pairings/${pairing["pairingId"]}/redeem`, {
                body: JSON.stringify({
                    agents,
                    installableAgents: [],
                    machineName: "Forward compat Runtime",
                    pairingCode: pairing["pairingCode"],
                    workspaceName: "forward-compat-workspace",
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            environment,
        ),
        200,
    );
    return {
        appId: app["appId"] as string,
        appCredential,
        projectId: projectId as string,
        runtimeCredential: claimed["runtimeCredential"] as string,
        runtimeId: claimed["runtimeId"] as string,
    };
}

describe.sequential("Platform protocol forward compatibility", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-16T00:00:00.000Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("Given a newer daemon advertising an additional capability and omitting later-added ones, When it redeems a pairing and a client reads the directory, Then pairing succeeds and decoding defaults unknown and missing fields to unsupported", async () => {
        const clerk = new FakeClerk();
        const application = createPlatformApplication(
            new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
            createPlatformGateways,
            () => clerk.organizationGateway,
        );
        const environment = bindings();
        const paired = await pairRuntime(application, environment, clerk, [futureAgent]);

        // The Relay persisted the directory it understood: the unknown field is
        // not echoed back, and every known field keeps its advertised value.
        const directory = await responseJson(
            await application.fetch(
                new Request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${paired.projectId}/runtimes/${paired.runtimeId}/agents`,
                    { headers: credentialHeaders(paired.appCredential) },
                ),
                environment,
            ),
            200,
        );
        expect(directory).toMatchObject({
            agents: [
                {
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
                        renameSession: false,
                        resumeSession: true,
                        steering: false,
                        unstableForkSession: false,
                    },
                    id: "codex",
                    label: "Codex",
                },
            ],
        });
        expect(JSON.stringify(directory)).not.toContain("futureCapability");

        // The SDK decodes the same directory a newer Relay might serve with
        // unknown fields still present; it must not reject the response.
        const sdkDecoded = decodeMobiusChannelDescriptor({
            agents: [
                {
                    agentPath: "/usr/local/bin/codex",
                    agentVersion: "codex 2.0.0",
                    capabilities: capabilitiesWithFutureField,
                    id: "codex",
                    label: "Codex",
                    sessionTurnConfiguration: true,
                },
            ],
            channelId: "channel-1",
            installableAgents: [],
            machineName: "Forward compat Runtime",
            projectId: "project-1",
            runtimeId: paired.runtimeId,
            workspaceName: "forward-compat-workspace",
        });
        expect(sdkDecoded.agents[0]?.capabilities.steering).toBe(false);
        expect(sdkDecoded.agents[0]?.capabilities.loadSession).toBe(true);

        // A legacy directory entry that omits later-added capability fields is
        // decoded with each missing field defaulting to unsupported.
        const legacyDecoded = decodeMobiusChannelDescriptor({
            agents: [{ ...legacyAgent }],
            channelId: "channel-1",
            installableAgents: [],
            machineName: "Forward compat Runtime",
            projectId: "project-1",
            runtimeId: paired.runtimeId,
            workspaceName: "forward-compat-workspace",
        });
        expect(legacyDecoded.agents[0]?.capabilities.promptQueueing).toBe(false);
        expect(legacyDecoded.agents[0]?.capabilities.steering).toBe(false);
    });

    it("Given a connected daemon that emits a live event batch containing an unknown content block type, When the event crosses the Relay, Then the stream stays open and the next event still reaches the viewer", async () => {
        const clerk = new FakeClerk();
        const application = createPlatformApplication(
            new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
            createPlatformGateways,
            () => clerk.organizationGateway,
        );
        const environment = bindings();
        const paired = await pairRuntime(application, environment, clerk, [futureAgent]);

        const daemonResponse = await application.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtimes/connect?liveness=1`, {
                headers: { authorization: `Bearer ${paired.runtimeCredential}`, Upgrade: "websocket" },
            }),
            environment,
        );
        const hostResponse = await application.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${paired.projectId}/runtimes/${paired.runtimeId}/host?token=${paired.appCredential}`,
                { headers: { Upgrade: "websocket" } },
            ),
            environment,
        );
        expect(daemonResponse.status).toBe(101);
        expect(hostResponse.status).toBe(101);
        if (daemonResponse.webSocket === null || hostResponse.webSocket === null) {
            throw new Error("Expected both channel sockets");
        }
        const daemon = daemonResponse.webSocket;
        const host = hostResponse.webSocket;
        const daemonMessages = new SocketMessages(daemon);
        const hostMessages = new SocketMessages(host);
        daemon.accept();
        host.accept();
        try {
            await daemonMessages.next();
            await hostMessages.next();

            const sessionId = "forward-compat-session";
            const sharedEvent = {
                eventId: "event-1",
                position: "1",
                provenance: { kind: "original" },
                recordedAt: "2026-10-16T00:00:00.000Z",
                sessionGenerationId: "session-generation-1",
                sessionId,
            };
            // A newer daemon emits a content block type this Relay does not know.
            daemon.send(
                JSON.stringify({
                    kind: "session.event.v2",
                    events: [
                        {
                            ...sharedEvent,
                            type: "acp",
                            payload: {
                                sessionUpdate: "agent_message_chunk",
                                content: { type: "external_video", mimeType: "video/mp4", videoKey: "a".repeat(64) },
                            },
                        },
                    ],
                }),
            );
            // The unknown block crosses as an explicit `unsupported` envelope
            // that keeps the original type and raw payload, and the follow-up
            // known event proves the stream survived the unknown one.
            const wrapped = decodeSessionEventEnvelopeV2(await hostMessages.next());
            expect(JSON.stringify(wrapped.events)).toContain("external_video");
            expect(JSON.stringify(wrapped.events)).toContain('"unsupported"');
            daemon.send(
                JSON.stringify({
                    kind: "session.event.v2",
                    events: [
                        {
                            ...sharedEvent,
                            eventId: "event-2",
                            position: "2",
                            type: "acp",
                            payload: {
                                sessionUpdate: "agent_message_chunk",
                                content: { type: "text", text: "still streaming" },
                            },
                        },
                    ],
                }),
            );
            const received = decodeSessionEventEnvelopeV2(await hostMessages.next());
            expect(JSON.stringify(received.events)).toContain("still streaming");
            expect(daemon.readyState).toBe(WebSocket.OPEN);
        } finally {
            daemon.close(1000, "done");
            host.close(1000, "done");
        }
    });

    it("Given a connected daemon that emits live events with an unknown session update, tool kind, tool status, tool content type, config option type, plan block type, lifecycle kind and payload type, When the events cross the Relay, Then the stream stays open and every event still reaches the viewer", async () => {
        const clerk = new FakeClerk();
        const application = createPlatformApplication(
            new PlatformAuthenticationConfiguration(clerk.authenticator, new Set(["developer-1"])),
            createPlatformGateways,
            () => clerk.organizationGateway,
        );
        const environment = bindings();
        const paired = await pairRuntime(application, environment, clerk, [futureAgent]);

        const daemonResponse = await application.fetch(
            new Request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/runtimes/connect?liveness=1`, {
                headers: { authorization: `Bearer ${paired.runtimeCredential}`, Upgrade: "websocket" },
            }),
            environment,
        );
        const hostResponse = await application.fetch(
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${paired.projectId}/runtimes/${paired.runtimeId}/host?token=${paired.appCredential}`,
                { headers: { Upgrade: "websocket" } },
            ),
            environment,
        );
        expect(daemonResponse.status).toBe(101);
        expect(hostResponse.status).toBe(101);
        if (daemonResponse.webSocket === null || hostResponse.webSocket === null) {
            throw new Error("Expected both channel sockets");
        }
        const daemon = daemonResponse.webSocket;
        const host = hostResponse.webSocket;
        const daemonMessages = new SocketMessages(daemon);
        const hostMessages = new SocketMessages(host);
        daemon.accept();
        host.accept();
        try {
            await daemonMessages.next();
            await hostMessages.next();

            const sessionId = "forward-compat-session";
            const sharedEvent = {
                eventId: "event-1",
                position: "1",
                provenance: { kind: "original" },
                recordedAt: "2026-10-16T00:00:00.000Z",
                sessionGenerationId: "session-generation-1",
                sessionId,
            };
            const sendEvents = (events: Array<Record<string, unknown>>) =>
                daemon.send(JSON.stringify({ kind: "session.event.v2", events }));
            const acpEvent = (eventId: string, position: string, payload: Record<string, unknown>) => ({
                ...sharedEvent,
                eventId,
                position,
                type: "acp",
                payload,
            });
            // Host attach emits a runtime status frame before event batches;
            // drain frames until the event envelope arrives.
            const nextEventEnvelope = async () => {
                for (;;) {
                    const frame = await hostMessages.next();
                    if (JSON.parse(frame).kind === "session.event.v2") {
                        return decodeSessionEventEnvelopeV2(frame);
                    }
                }
            };

            // A newer daemon emits payload variants this Relay does not know.
            sendEvents([
                acpEvent("event-1", "1", { sessionUpdate: "agent_prediction_chunk", text: "predicting" }),
                acpEvent("event-2", "2", {
                    kind: "subagent_invoke",
                    sessionUpdate: "tool_call",
                    title: "Future tool call",
                    toolCallId: "tool-future",
                }),
                acpEvent("event-3", "3", {
                    kind: "container",
                    sessionUpdate: "tool_call",
                    title: "Unknown kind",
                    toolCallId: "tool-kind",
                }),
                acpEvent("event-4", "4", {
                    sessionUpdate: "tool_call",
                    status: "paused",
                    title: "Unknown status",
                    toolCallId: "tool-status",
                }),
                acpEvent("event-5", "5", {
                    content: [
                        { content: { type: "text", text: "before" }, type: "content" },
                        { type: "annotation", annotationId: "note-1" },
                        { content: { type: "text", text: "after" }, type: "content" },
                    ],
                    sessionUpdate: "tool_call",
                    title: "Unknown tool content",
                    toolCallId: "tool-content",
                }),
                acpEvent("event-6", "6", {
                    sessionUpdate: "config_option_update",
                    configOptions: [{ currentValue: "0.7", id: "temperature", name: "Temperature", type: "slider" }],
                }),
                acpEvent("event-7", "7", {
                    plan: { planId: "plan-future", type: "canvas", uri: "mobius-plan://canvas/1" },
                    sessionUpdate: "plan_update",
                }),
                // Unknown lifecycle metadata kind and unknown top-level payload
                // type travel in the same batch as known events.
                {
                    ...sharedEvent,
                    eventId: "event-8",
                    position: "8",
                    type: "lifecycle-metadata",
                    payload: { commandId: "command-1", kind: "prompt.compacted" },
                },
                {
                    ...sharedEvent,
                    eventId: "event-9",
                    position: "9",
                    type: "telemetry",
                    payload: { counters: { tokens: 42 } },
                },
                acpEvent("event-10", "10", {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "still streaming" },
                }),
            ]);

            // Wrapped unknown discriminators keep their original value inside the
            // unsupported envelope; unknown enum values degrade to their designed
            // fallbacks; every event still arrives in order.
            const batch = await nextEventEnvelope();
            const encoded = JSON.stringify(batch.events);
            for (const expected of [
                "agent_prediction_chunk",
                "Future tool call",
                "Unknown kind",
                "Unknown status",
                "annotation",
                "slider",
                "canvas",
                "prompt.compacted",
                "telemetry",
            ]) {
                expect(encoded).toContain(expected);
            }
            expect(encoded).toContain("still streaming");
            expect(batch.events).toHaveLength(10);
            expect(daemon.readyState).toBe(WebSocket.OPEN);
        } finally {
            daemon.close(1000, "done");
            host.close(1000, "done");
        }
    });
});
