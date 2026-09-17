import { env, runInDurableObject } from "cloudflare:test";
import {
    AGENT_ACTIVITY_KIND,
    BotExecutionBindingApprovedEvent,
    DEFAULT_AGENT_EXECUTION_CONFIGURATION,
    decodeBotExecutionBindingApprovalRequest,
    decodeBotSessionPromptCommand,
    decodeSessionEventAcknowledgement,
    decodeSessionEventRejection,
    decodeSessionPrepareCommand,
    encodeBotExecutionBindingApprovedEvent,
    encodeSessionEventEnvelope,
    encodeSessionReadyEvent,
    MOBIUS_API_PREFIX,
    SESSION_COMPLETED_KIND,
    SESSION_EVENT_KIND,
    SESSION_STARTED_KIND,
    type SessionEventEnvelope,
    SessionEventRejectionCode,
} from "@moxt-ai/mobius-protocol";
import {
    MobiusBotOwnerClient,
    MobiusNoBotCompletionPolicy,
    StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMobiusApp } from "../../../tests/infra/app.ts";
import { createStandaloneGateways } from "../src/worker.ts";
import { testBindings } from "./infra/bindings.ts";

const relayOrigin = "https://relay.test";
const connectorScopeList = [
    "conversation-events:read",
    "inbound-conversation:create",
    "inbound-message:create",
    "outbound-message:ack",
    "outbound-message:read",
    "turn:cancel",
];
const readyAgent = {
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
    botSessionConfiguration: true,
    id: "codex",
    label: "Codex",
};
const readyAgents = [readyAgent];

interface CreatedPairing {
    readonly app: ReturnType<typeof createTestMobiusApp>;
    readonly client: MobiusBotOwnerClient;
    readonly signal: AbortSignal;
    readonly channelId: string;
    readonly daemonToken: string;
    readonly hostToken: string;
    readonly pairingCode: string;
    readonly projectId: string;
    readonly runtimeId: string;
}

interface CreatedBot {
    readonly botId: string;
    readonly lifecycleRevision: number;
}

interface CreatedBehavior {
    readonly behaviorRevisionId: string;
}

interface RedeemedConnection {
    readonly connectionId: string;
    readonly credential: string;
}

interface CreatedConnectionGrant {
    readonly app: ReturnType<typeof createTestMobiusApp>;
    readonly grantId: string;
    readonly grantSecret: string;
}

interface CreatedTarget {
    readonly deliveryTargetId: string;
}

interface CreatedBinding {
    readonly bindingId: string;
    readonly bindingRevision: number;
}

interface CreatedConversation {
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly conversationId: string;
    readonly sessionId: string;
}

interface AcceptedMessage {
    readonly duplicate: boolean;
    readonly executionId: string;
    readonly turnId: string;
}

interface OpenSocket {
    readonly messages: SocketMessages;
    readonly socket: WebSocket;
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
        if (message !== undefined) {
            return Promise.resolve(message);
        }
        return new Promise((resolve) => this.#resolvers.push(resolve));
    };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Expected a response object");
    }
    return Object.fromEntries(Object.entries(value));
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) {
        throw new Error(`Expected ${key}`);
    }
    return field;
}

function integerField(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field)) {
        throw new Error(`Expected ${key}`);
    }
    return field;
}

function recordArrayField(
    value: Readonly<Record<string, unknown>>,
    key: string,
): readonly Readonly<Record<string, unknown>>[] {
    const field = value[key];
    if (!Array.isArray(field)) {
        throw new Error(`Expected ${key}`);
    }
    return field.map(record);
}

async function json(response: Response, status: number): Promise<Readonly<Record<string, unknown>>> {
    const detail = response.status === status ? "" : await response.clone().text();
    expect(response.status, detail).toBe(status);
    return record(await response.json());
}

async function expectApiError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
}

function ownerHeaders(pairing: CreatedPairing): HeadersInit {
    return {
        authorization: `Bearer ${pairing.hostToken}`,
        "content-type": "application/json",
    };
}

function connectorHeaders(connection: RedeemedConnection): HeadersInit {
    return {
        authorization: `Bearer ${connection.credential}`,
        "content-type": "application/json",
    };
}

async function pairRuntime(
    app: ReturnType<typeof createTestMobiusApp>,
    signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<CreatedPairing> {
    const created = await json(
        await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings`, { method: "POST", signal }),
        201,
    );
    const claim = await json(
        await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings/claim`, {
            body: JSON.stringify({
                agents: readyAgents,
                installableAgents: [],
                machineName: "Bot Runtime",
                pairingCode: stringField(created, "pairingCode"),
                workspaceName: "mobius",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal,
        }),
        200,
    );
    return {
        channelId: stringField(created, "channelId"),
        daemonToken: stringField(claim, "daemonToken"),
        hostToken: stringField(created, "hostToken"),
        app,
        signal,
        client: new MobiusBotOwnerClient({
            endpoint: relayOrigin,
            projectId: stringField(created, "projectId"),
            credentialProvider: new StaticMobiusCredentialProvider(stringField(created, "hostToken")),
            actorReference: "project-owner",
            transport: { fetch: async (request) => await app.request(request) },
        }),
        pairingCode: stringField(created, "pairingCode"),
        projectId: stringField(created, "projectId"),
        runtimeId: stringField(created, "runtimeId"),
    };
}

async function pairAdditionalRuntime(owner: CreatedPairing, label: string): Promise<CreatedPairing> {
    const app = owner.app;
    const created = await json(
        await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/projects/${owner.projectId}/runtime-pairings`, {
            body: JSON.stringify({ idempotencyKey: `runtime-${label}` }),
            headers: ownerHeaders(owner),
            method: "POST",
        }),
        201,
    );
    const claim = await json(
        await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/pairings/claim`, {
            body: JSON.stringify({
                agents: readyAgents,
                installableAgents: [],
                machineName: `Bot Runtime ${label}`,
                pairingCode: stringField(created, "pairingCode"),
                workspaceName: `mobius-${label}`,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
        200,
    );
    return {
        channelId: stringField(created, "channelId"),
        daemonToken: stringField(claim, "daemonToken"),
        hostToken: owner.hostToken,
        app,
        client: owner.client,
        signal: owner.signal,
        pairingCode: stringField(created, "pairingCode"),
        projectId: owner.projectId,
        runtimeId: stringField(created, "runtimeId"),
    };
}

function requireWebSocket(response: Response): WebSocket {
    const socket = response.webSocket;
    if (socket === null) {
        throw new Error("Expected a WebSocket response");
    }
    return socket;
}

async function openDaemon(pairing: CreatedPairing): Promise<OpenSocket> {
    const app = pairing.app;
    const response = await app.request(
        `${relayOrigin}${MOBIUS_API_PREFIX}/channels/${pairing.channelId}/daemon?token=${pairing.daemonToken}`,
        { headers: { Upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const socket = requireWebSocket(response);
    const messages = new SocketMessages(socket);
    socket.accept();
    return { messages, socket };
}

async function createConnectionGrant(
    pairing: CreatedPairing,
    bot: CreatedBot,
    label: string,
    scopes: readonly string[] = connectorScopeList,
): Promise<CreatedConnectionGrant> {
    const app = pairing.app;
    const grant = await json(
        await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/connection-grants`,
            {
                body: JSON.stringify({
                    audience: "test-connector",
                    expiresInSeconds: 600,
                    label: `Connection ${label}`,
                    scopes,
                }),
                headers: ownerHeaders(pairing),
                method: "POST",
            },
        ),
        201,
    );
    return {
        grantId: stringField(grant, "grantId"),
        grantSecret: stringField(grant, "grantSecret"),
        app,
    };
}

async function redeemConnectionGrant(grant: CreatedConnectionGrant, label: string): Promise<RedeemedConnection> {
    const app = grant.app;
    const redeemed = await json(
        await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connection-grants/redeem`, {
            body: JSON.stringify({
                audience: "test-connector",
                connectorPrincipalId: `principal-${label}`,
                grantId: grant.grantId,
                grantSecret: grant.grantSecret,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
        201,
    );
    return {
        connectionId: stringField(redeemed, "connectionId"),
        credential: stringField(redeemed, "credential"),
    };
}

async function connectBot(
    pairing: CreatedPairing,
    bot: CreatedBot,
    label: string,
    scopes: readonly string[] = connectorScopeList,
): Promise<RedeemedConnection> {
    return await redeemConnectionGrant(await createConnectionGrant(pairing, bot, label, scopes), label);
}

async function createTarget(
    pairing: CreatedPairing,
    bot: CreatedBot,
    connection: RedeemedConnection,
    alias: string,
): Promise<CreatedTarget> {
    const app = pairing.app;
    const target = await json(
        await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connection.connectionId}/delivery-targets`,
            {
                body: JSON.stringify({ alias }),
                headers: connectorHeaders(connection),
                method: "POST",
            },
        ),
        201,
    );
    const deliveryTargetId = stringField(target, "deliveryTargetId");
    await json(
        await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/delivery-targets/${deliveryTargetId}/approve`,
            {
                body: JSON.stringify({ expectedPolicyRevision: 0 }),
                headers: ownerHeaders(pairing),
                method: "POST",
            },
        ),
        200,
    );
    return { deliveryTargetId };
}

async function approveBinding(
    pairing: CreatedPairing,
    daemon: OpenSocket,
    bot: CreatedBot,
    behavior: CreatedBehavior,
    target: CreatedTarget,
    expectedRevision = bot.lifecycleRevision,
    policy: Readonly<Record<string, unknown>> = { kind: "none" },
    workspaceRef = "default",
): Promise<CreatedBinding> {
    const app = pairing.app;
    const response = await json(
        await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/execution-bindings`,
            {
                body: JSON.stringify({
                    agentConfigRevision: 1,
                    agentRef: "codex",
                    allowedDeliveryTargetIds: [target.deliveryTargetId],
                    behaviorRevisionId: behavior.behaviorRevisionId,
                    completionPolicy: policy,
                    executionConfiguration: DEFAULT_AGENT_EXECUTION_CONFIGURATION,
                    expectedRevision,
                    runtimeId: pairing.runtimeId,
                    workspaceRef,
                }),
                headers: ownerHeaders(pairing),
                method: "POST",
            },
        ),
        202,
    );
    const request = decodeBotExecutionBindingApprovalRequest(await daemon.messages.next());
    expect(request).toMatchObject({
        agentRef: "codex",
        behaviorRevisionId: behavior.behaviorRevisionId,
        botId: bot.botId,
        runtimeId: pairing.runtimeId,
        workspaceRef,
    });
    const approved = new BotExecutionBindingApprovedEvent(
        request.requestId,
        request.botId,
        request.behaviorRevisionId,
        request.bindingId,
        request.bindingRevision,
        `grant_${bot.botId}`,
        "a".repeat(64),
        "b".repeat(64),
    );
    daemon.socket.send(encodeBotExecutionBindingApprovedEvent(approved));
    expect(await daemon.messages.next()).toBe(encodeBotExecutionBindingApprovedEvent(approved));
    const active = await json(
        await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}`, {
            headers: ownerHeaders(pairing),
        }),
        200,
    );
    expect(active).toMatchObject({
        activeBehaviorRevisionId: behavior.behaviorRevisionId,
        activeBindingId: request.bindingId,
        lifecycle: "active",
    });
    const approvedLifecycleRevision = integerField(active, "lifecycleRevision");
    daemon.socket.send(encodeBotExecutionBindingApprovedEvent(approved));
    expect(await daemon.messages.next()).toBe(encodeBotExecutionBindingApprovedEvent(approved));
    const replayed = await json(
        await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}`, {
            headers: ownerHeaders(pairing),
        }),
        200,
    );
    expect(integerField(replayed, "lifecycleRevision")).toBe(approvedLifecycleRevision);
    return {
        bindingId: stringField(response, "bindingId"),
        bindingRevision: integerField(response, "bindingRevision"),
    };
}

async function createConnectedConversation(
    pairing: CreatedPairing,
    bot: CreatedBot,
    connection: RedeemedConnection,
    target: CreatedTarget,
    key: string,
): Promise<CreatedConversation> {
    const app = pairing.app;
    const response = await json(
        await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
            {
                body: JSON.stringify({
                    clientConversationKey: key,
                    replyDeliveryTargetId: target.deliveryTargetId,
                    title: `Conversation ${key}`,
                }),
                headers: connectorHeaders(connection),
                method: "POST",
            },
        ),
        201,
    );
    expect(response["creatorKind"]).toBe("connection");
    return {
        behaviorRevisionId: stringField(response, "behaviorRevisionId"),
        bindingId: stringField(response, "bindingId"),
        bindingRevision: integerField(response, "bindingRevision"),
        conversationId: stringField(response, "conversationId"),
        sessionId: stringField(response, "sessionId"),
    };
}

function attemptEnvelope(
    sessionId: string,
    commandId: string,
    eventId: string,
    kind: string,
    attemptId: string,
    sourceSequence: number,
): SessionEventEnvelope {
    const payload =
        kind === SESSION_STARTED_KIND
            ? {
                  attemptId,
                  commandId,
                  kind: SESSION_STARTED_KIND,
                  sessionId,
              }
            : {
                  commandId,
                  kind: SESSION_COMPLETED_KIND,
                  sessionId,
                  stopReason: "end_turn",
              };
    return {
        eventId,
        kind: SESSION_EVENT_KIND,
        payload: JSON.stringify(payload),
        sessionId,
        source: {
            attemptId,
            kind: "attempt",
            sourceSeq: sourceSequence.toString(),
        },
    };
}

function activityEnvelope(
    sessionId: string,
    commandId: string,
    attemptId: string,
    eventId: string,
    sourceSequence: number,
): SessionEventEnvelope {
    return {
        eventId,
        kind: SESSION_EVENT_KIND,
        payload: JSON.stringify({
            activityId: "activity-sensitive",
            activityType: "tool",
            commandId,
            content: [
                {
                    artifactId: "",
                    data: "",
                    mimeType: "",
                    name: "",
                    newText: "secret output",
                    oldText: "",
                    path: "/private/workspace/secret.txt",
                    terminalId: "",
                    text: "",
                    type: "diff",
                    uri: "",
                },
            ],
            detail: {
                content: [],
                input: '{"path":"/private/workspace/secret.txt"}',
                kind: "recorded",
                output: "private result",
            },
            input: '{"path":"/private/workspace/secret.txt"}',
            kind: AGENT_ACTIVITY_KIND,
            locations: ["/private/workspace/secret.txt"],
            name: "read_file",
            output: "private result",
            sequence: 1,
            sessionId,
            status: "completed",
            title: "Read a private file",
            toolKind: "read",
        }),
        sessionId,
        source: {
            attemptId,
            kind: "attempt",
            sourceSeq: sourceSequence.toString(),
        },
    };
}

function executionHeaders(pairing: CreatedPairing, capabilitySecret: string): HeadersInit {
    return {
        authorization: `Bearer ${pairing.daemonToken}`,
        "content-type": "application/json",
        "x-mobius-bot-execution-capability": capabilitySecret,
    };
}

async function commitAttemptEvent(daemon: OpenSocket, envelope: SessionEventEnvelope): Promise<void> {
    daemon.socket.send(encodeSessionEventEnvelope(envelope));
    expect(decodeSessionEventAcknowledgement(await daemon.messages.next())).toMatchObject({
        duplicate: false,
        eventId: envelope.eventId,
        sessionId: envelope.sessionId,
    });
}

async function expectConversationHistory(
    pairing: CreatedPairing,
    bot: CreatedBot,
    conversation: CreatedConversation,
    accepted: AcceptedMessage,
    behavior: CreatedBehavior,
): Promise<void> {
    const app = pairing.app;
    const endpoint = `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations/${conversation.conversationId}`;
    const messages = await json(await app.request(`${endpoint}/messages`, { headers: ownerHeaders(pairing) }), 200);
    expect(recordArrayField(messages, "messages")).toMatchObject([
        {
            behaviorRevisionId: behavior.behaviorRevisionId,
            executionId: accepted.executionId,
            turnId: accepted.turnId,
        },
    ]);
    const events = await json(
        await app.request(`${endpoint}/events?after=${encodeURIComponent(stringField(messages, "tailEventCursor"))}`, {
            headers: ownerHeaders(pairing),
        }),
        200,
    );
    expect(recordArrayField(events, "events")).toEqual([]);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T08:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("Provider-neutral Bot API", () => {
    it("Given a bot needing setup, When its owner configures an execution target and the runtime approves it, Then setup progresses from unconfigured to awaiting approval to ready", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const bot = await pairing.client.createBot(
            { displayName: "Setup acceptance", avatarRef: "", description: "Setup acceptance description" },
            pairing.signal,
        );
        const setupUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/setup`;
        const initial = await json(await app.request(setupUrl, { headers: ownerHeaders(pairing) }), 200);
        expect(initial).toMatchObject({
            behaviorRevision: 0,
            lifecycleRevision: 1,
            configuration: { kind: "not-configured" },
        });
        const behavior = await pairing.client.createBehavior(
            bot.botId,
            {
                agentConfiguration: {},
                expectedRevision: 0,
                instructions: "You are Setup acceptance.",
                requiredCapabilities: ["embedded-context"],
            },
            pairing.signal,
        );
        const daemon = await openDaemon(pairing);
        try {
            await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/execution-bindings`,
                    {
                        method: "POST",
                        headers: ownerHeaders(pairing),
                        body: JSON.stringify({
                            agentConfigRevision: 1,
                            agentRef: "codex",
                            allowedDeliveryTargetIds: [],
                            behaviorRevisionId: behavior.behaviorRevisionId,
                            completionPolicy: { kind: "none" },
                            executionConfiguration: DEFAULT_AGENT_EXECUTION_CONFIGURATION,
                            expectedRevision: 1,
                            runtimeId: pairing.runtimeId,
                            workspaceRef: "default",
                        }),
                    },
                ),
                202,
            );
            expect(await json(await app.request(setupUrl, { headers: ownerHeaders(pairing) }), 200)).toMatchObject({
                configuration: { kind: "requested", agentRef: "codex", workspaceRef: "default" },
            });
            const request = decodeBotExecutionBindingApprovalRequest(await daemon.messages.next());
            const approved = new BotExecutionBindingApprovedEvent(
                request.requestId,
                request.botId,
                request.behaviorRevisionId,
                request.bindingId,
                request.bindingRevision,
                `grant_${bot.botId}`,
                "a".repeat(64),
                "b".repeat(64),
            );
            daemon.socket.send(encodeBotExecutionBindingApprovedEvent(approved));
            await daemon.messages.next();
            expect(await json(await app.request(setupUrl, { headers: ownerHeaders(pairing) }), 200)).toMatchObject({
                lifecycle: "active",
                configuration: { kind: "approved", runtimeId: pairing.runtimeId, agentRef: "codex" },
            });
        } finally {
            daemon.socket.close();
        }
    });

    it("Given a Bot behavior overrides the required permission setting, When its owner creates a binding, Then the Relay rejects the conflicting configuration", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const bot = await pairing.client.createBot(
            {
                avatarRef: "",
                description: "Required execution settings stay binding-owned",
                displayName: "Permission override",
            },
            pairing.signal,
        );
        const behavior = await pairing.client.createBehavior(
            bot.botId,
            {
                agentConfiguration: {
                    sessionConfigurations: [
                        {
                            booleanValue: false,
                            configId: "permission_mode",
                            value: "danger-full-access",
                            valueType: "select",
                        },
                    ],
                },
                expectedRevision: 0,
                instructions: "Use only the binding-owned execution settings.",
                requiredCapabilities: ["embedded-context"],
            },
            pairing.signal,
        );

        await expect(
            pairing.client.createBinding(
                bot.botId,
                {
                    agentConfigRevision: 1,
                    agentRef: "codex",
                    allowedDeliveryTargetIds: [],
                    behaviorRevisionId: behavior.behaviorRevisionId,
                    completionPolicy: new MobiusNoBotCompletionPolicy(),
                    executionConfiguration: DEFAULT_AGENT_EXECUTION_CONFIGURATION,
                    expectedRevision: bot.lifecycleRevision,
                    runtimeId: pairing.runtimeId,
                    workspaceRef: "default",
                },
                pairing.signal,
            ),
        ).rejects.toMatchObject({ code: "invalid_request" });
    });

    it("Given an approved Bot binding, When its legacy owner endpoint loads Agent settings, Then Mobius preserves the legacy transient configuration snapshot", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const bot = await pairing.client.createBot(
                {
                    displayName: "Configuration inspection",
                    avatarRef: "",
                    description: "Configuration inspection description",
                },
                pairing.signal,
            );
            const connection = await connectBot(pairing, bot, "configuration-inspection");
            const target = await createTarget(pairing, bot, connection, "configuration-inspection-target");
            const behavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: { sessionConfigurations: [] },
                    expectedRevision: 0,
                    instructions: "Inspect only the selected Agent configuration.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            await approveBinding(pairing, daemon, bot, behavior, target);

            let deprecation = "";
            const legacyClient = new MobiusBotOwnerClient({
                actorReference: "project-owner",
                credentialProvider: new StaticMobiusCredentialProvider(pairing.hostToken),
                endpoint: relayOrigin,
                projectId: pairing.projectId,
                transport: {
                    fetch: async (request) => {
                        const response = await app.request(request);
                        deprecation = response.headers.get("deprecation") ?? "";
                        return response;
                    },
                },
            });
            const pending = legacyClient.readAgentConfiguration(bot.botId, pairing.signal);
            const prepare = decodeSessionPrepareCommand(await daemon.messages.next());
            expect(prepare).toMatchObject({
                agentId: "codex",
                directoryId: "default",
                transient: true,
            });
            daemon.socket.send(
                encodeSessionReadyEvent({
                    additionalDirectories: [],
                    agentId: "codex",
                    agentName: "Codex",
                    agentVersion: "codex 1.0.0",
                    capabilities: readyAgent.capabilities,
                    commands: [],
                    configOptions: [
                        {
                            booleanValue: false,
                            category: "model",
                            currentValue: "test-small",
                            description: "Choose the coding model.",
                            id: "model",
                            name: "Model",
                            type: "select",
                            values: [
                                {
                                    description: "Default model",
                                    groupId: "default",
                                    groupName: "Default",
                                    name: "Test Small",
                                    value: "test-small",
                                },
                            ],
                        },
                    ],
                    directoryId: "default",
                    directoryLabel: "Mobius",
                    kind: "session.ready",
                    requestId: prepare.requestId,
                    restored: false,
                    sessionId: prepare.sessionId,
                }),
            );

            const snapshot = await pending;
            expect(deprecation).toBe("true");
            expect(snapshot.options).toStrictEqual([
                expect.objectContaining({ currentValue: "test-small", id: "model", type: "select" }),
            ]);
            expect(snapshot).not.toHaveProperty("sessionId");
            expect(
                (
                    await app.request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${pairing.projectId}/sessions/${prepare.sessionId}`,
                        { headers: ownerHeaders(pairing) },
                    )
                ).status,
            ).toBe(404);
        } finally {
            daemon.socket.close(1000, "Configuration inspection complete");
        }
    });

    it("Given an owner manages an active Bot, When its owner directories and lifecycle controls are used, Then Web-safe resources remain durable and locally sensitive binding details stay private", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const bot = await pairing.client.createBot(
                { displayName: "Managed Bot", avatarRef: "", description: "Managed Bot description" },
                pairing.signal,
            );
            const botDirectory = await json(
                await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots`, {
                    headers: ownerHeaders(pairing),
                }),
                200,
            );
            expect(recordArrayField(botDirectory, "bots")).toMatchObject([
                { botId: bot.botId, displayName: "Managed Bot", lifecycle: "draft" },
            ]);

            const connection = await connectBot(pairing, bot, "managed");
            const target = await createTarget(pairing, bot, connection, "managed-target");
            const behavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Managed Bot.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            await approveBinding(pairing, daemon, bot, behavior, target);
            const conversation = await pairing.client.createConversation(
                bot.botId,
                { clientConversationKey: "managed-conversation" },
                pairing.signal,
            );

            const behaviors = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/behavior-revisions`,
                    { headers: ownerHeaders(pairing) },
                ),
                200,
            );
            expect(recordArrayField(behaviors, "behaviorRevisions")).toMatchObject([
                { behaviorRevisionId: behavior.behaviorRevisionId, lifecycle: "approved", revisionNumber: 1 },
            ]);

            const bindings = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/execution-bindings`,
                    { headers: ownerHeaders(pairing) },
                ),
                200,
            );
            const binding = recordArrayField(bindings, "executionBindings")[0];
            expect(binding).toMatchObject({
                agentRef: "codex",
                executionConfiguration: DEFAULT_AGENT_EXECUTION_CONFIGURATION,
                lifecycle: "approved",
                workspaceRef: "default",
            });
            expect(binding).not.toHaveProperty("localGrantId");
            expect(binding).not.toHaveProperty("agentIdentityDigest");
            expect(binding).not.toHaveProperty("workspaceIdentityDigest");

            const conversations = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
                    {
                        headers: ownerHeaders(pairing),
                    },
                ),
                200,
            );
            expect(recordArrayField(conversations, "conversations")).toMatchObject([
                { conversationId: conversation.conversationId, creatorKind: "owner", lifecycle: "active" },
            ]);

            const connectionDirectory = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/connections`,
                    {
                        headers: ownerHeaders(pairing),
                    },
                ),
                200,
            );
            expect(recordArrayField(connectionDirectory, "connections")).toMatchObject([
                { connectionId: connection.connectionId, lifecycle: "active" },
            ]);
            expect(recordArrayField(connectionDirectory, "deliveryTargets")).toMatchObject([
                { deliveryTargetId: target.deliveryTargetId, lifecycle: "active", ownerApproved: true },
            ]);

            const active = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}`,
                    {
                        headers: ownerHeaders(pairing),
                    },
                ),
                200,
            );
            const suspended = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/suspend`,
                    {
                        body: JSON.stringify({ expectedRevision: integerField(active, "lifecycleRevision") }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                200,
            );
            expect(suspended["lifecycle"]).toBe("suspended");
            const resumed = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/resume`,
                    {
                        body: JSON.stringify({ expectedRevision: integerField(suspended, "lifecycleRevision") }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                200,
            );
            expect(resumed["lifecycle"]).toBe("active");
            const suspendedAgain = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/suspend`,
                    {
                        body: JSON.stringify({ expectedRevision: integerField(resumed, "lifecycleRevision") }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                200,
            );
            const resumedAgain = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/resume`,
                    {
                        body: JSON.stringify({ expectedRevision: integerField(suspendedAgain, "lifecycleRevision") }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                200,
            );
            expect(resumedAgain["lifecycle"]).toBe("active");

            await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/connections/${connection.connectionId}/revoke`,
                    {
                        body: JSON.stringify({ expectedRevision: 1 }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                200,
            );
            const revokedDirectory = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/connections`,
                    {
                        headers: ownerHeaders(pairing),
                    },
                ),
                200,
            );
            expect(recordArrayField(revokedDirectory, "connections")).toMatchObject([
                { connectionId: connection.connectionId, lifecycle: "revoked" },
            ]);
            expect(recordArrayField(revokedDirectory, "deliveryTargets")).toMatchObject([
                { deliveryTargetId: target.deliveryTargetId, lifecycle: "disabled", ownerApproved: true },
            ]);
        } finally {
            daemon.socket.close(1000, "Owner management contract complete");
        }
    });

    it("Given a Bot is approved for a deeply nested local directory, When its owner creates a conversation, Then the Session is provisioned in that directory", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const bot = await pairing.client.createBot(
                { displayName: "Deep workspace", avatarRef: "", description: "Deep workspace description" },
                pairing.signal,
            );
            const connection = await connectBot(pairing, bot, "deep-workspace");
            const target = await createTarget(pairing, bot, connection, "deep-workspace-target");
            const behavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "Work in the approved local directory.",
                    requiredCapabilities: [],
                },
                pairing.signal,
            );
            const workspaceRef = `path-${"a".repeat(1024)}`;
            await approveBinding(
                pairing,
                daemon,
                bot,
                behavior,
                target,
                bot.lifecycleRevision,
                { kind: "none" },
                workspaceRef,
            );

            const conversation = await pairing.client.createConversation(
                bot.botId,
                { clientConversationKey: "deep-workspace-conversation" },
                pairing.signal,
            );

            expect(conversation).toMatchObject({ state: { kind: "active" } });
        } finally {
            daemon.socket.close(1000, "Deep workspace test complete");
        }
    });

    it("Given an owner Bot has an untouched New chat, When another draft is requested and the first prompt is sent, Then one draft is reused and titled automatically", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const bot = await pairing.client.createBot(
                { displayName: "Single draft", avatarRef: "", description: "Single draft description" },
                pairing.signal,
            );
            const connection = await connectBot(pairing, bot, "single-draft");
            const target = await createTarget(pairing, bot, connection, "single-draft-target");
            const behavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Single draft.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            await approveBinding(pairing, daemon, bot, behavior, target);

            const first = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
                    {
                        body: JSON.stringify({ clientConversationKey: "owner-draft-one" }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                201,
            );
            const reopened = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
                    {
                        body: JSON.stringify({ clientConversationKey: "owner-draft-two" }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                201,
            );
            expect(first["title"]).toBe("New chat");
            expect(reopened).toMatchObject({
                conversationId: stringField(first, "conversationId"),
                sessionId: stringField(first, "sessionId"),
                title: "New chat",
            });

            const conversation: CreatedConversation = {
                behaviorRevisionId: stringField(first, "behaviorRevisionId"),
                bindingId: stringField(first, "bindingId"),
                bindingRevision: integerField(first, "bindingRevision"),
                conversationId: stringField(first, "conversationId"),
                sessionId: stringField(first, "sessionId"),
            };
            await pairing.client.submitMessage(
                bot.botId,
                conversation.conversationId,
                {
                    actorRef: "project-owner",
                    artifactIds: [],
                    clientMessageId: "owner-first-prompt",
                    text: "Run owner-first-prompt",
                },
                pairing.signal,
            );
            await daemon.messages.next();

            const afterPrompt = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
                    {
                        headers: ownerHeaders(pairing),
                    },
                ),
                200,
            );
            expect(recordArrayField(afterPrompt, "conversations")).toMatchObject([
                {
                    conversationId: conversation.conversationId,
                    title: "Run owner-first-prompt",
                },
            ]);

            const nextDraft = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
                    {
                        body: JSON.stringify({ clientConversationKey: "owner-draft-three" }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                201,
            );
            expect(stringField(nextDraft, "conversationId")).not.toBe(conversation.conversationId);
            expect(nextDraft["title"]).toBe("New chat");
            const originalReplay = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
                    {
                        body: JSON.stringify({ clientConversationKey: "owner-draft-one" }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                201,
            );
            expect(originalReplay).toMatchObject({
                conversationId: conversation.conversationId,
                title: "Run owner-first-prompt",
            });
            const draftCount = await env.DIRECTORY_DATABASE.prepare(
                `SELECT COUNT(*) AS count FROM bot_owner_conversation_drafts WHERE bot_id = ?`,
            )
                .bind(bot.botId)
                .first<{ readonly count: number }>();
            expect(draftCount?.count).toBe(1);
        } finally {
            daemon.socket.close(1000, "Test complete");
        }
    });

    it("Given an unbound Bot and untrusted public requests, When conversation input is decoded, Then execution targets are rejected before authorization or resolution", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const bot = await pairing.client.createBot(
            { displayName: "Unbound", avatarRef: "", description: "Unbound description" },
            pairing.signal,
        );
        const validConversation = { clientConversationKey: "unbound-conversation" };
        await expectApiError(
            await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
                {
                    body: JSON.stringify(validConversation),
                    headers: ownerHeaders(pairing),
                    method: "POST",
                },
            ),
            409,
            "binding_not_approved",
        );

        const forbiddenFields = [
            "agentId",
            "runtimeId",
            "workspaceRef",
            "command",
            "path",
            "provider",
            "providerDestination",
            "callbackUrl",
            "localPermissionDecision",
            "title",
        ];
        for (const field of forbiddenFields) {
            await expectApiError(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
                    {
                        body: JSON.stringify({ ...validConversation, [field]: "untrusted" }),
                        headers: {
                            authorization: `Bearer ${"z".repeat(43)}`,
                            "content-type": "application/json",
                        },
                        method: "POST",
                    },
                ),
                400,
                "invalid_request",
            );
        }
    });

    it("Given one binding approval is pending for a Bot, When another request races for the same Bot, Then only one local approval can remain outstanding", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const bot = await pairing.client.createBot(
                { displayName: "Pending binding", avatarRef: "", description: "Pending binding description" },
                pairing.signal,
            );
            const connection = await connectBot(pairing, bot, "pending-binding");
            const target = await createTarget(pairing, bot, connection, "pending-binding-target");
            const behavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Pending binding.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            const requestBodyValue = {
                agentConfigRevision: 1,
                agentRef: "codex",
                allowedDeliveryTargetIds: [target.deliveryTargetId],
                behaviorRevisionId: behavior.behaviorRevisionId,
                completionPolicy: { kind: "none" },
                executionConfiguration: DEFAULT_AGENT_EXECUTION_CONFIGURATION,
                expectedRevision: bot.lifecycleRevision,
                runtimeId: pairing.runtimeId,
                workspaceRef: "default",
            };
            await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/execution-bindings`,
                    {
                        body: JSON.stringify(requestBodyValue),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                202,
            );
            await expectApiError(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/execution-bindings`,
                    {
                        body: JSON.stringify(requestBodyValue),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                409,
                "revision_conflict",
            );
            const pending = await env.DIRECTORY_DATABASE.prepare(
                `SELECT COUNT(*) AS count FROM bot_execution_bindings
                  WHERE bot_id = ? AND lifecycle = 'requested'`,
            )
                .bind(bot.botId)
                .first<{ readonly count: number }>();
            expect(pending?.count).toBe(1);
        } finally {
            daemon.socket.close(1000, "Test complete");
        }
    });

    it("Given a delivery target approval already committed, When a stale revision retries, Then no rejected audit event is persisted", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const bot = await pairing.client.createBot(
            { displayName: "Target approval audit", avatarRef: "", description: "Target approval audit description" },
            pairing.signal,
        );
        const connection = await connectBot(pairing, bot, "target-approval-audit");
        const target = await createTarget(pairing, bot, connection, "approved-target");

        await expectApiError(
            await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/delivery-targets/${target.deliveryTargetId}/approve`,
                {
                    body: JSON.stringify({ expectedPolicyRevision: 0 }),
                    headers: ownerHeaders(pairing),
                    method: "POST",
                },
            ),
            409,
            "revision_conflict",
        );

        const state = await env.DIRECTORY_DATABASE.prepare(
            `SELECT owner_approved, outbound_policy_revision
               FROM bot_delivery_targets
              WHERE delivery_target_id = ?`,
        )
            .bind(target.deliveryTargetId)
            .first<{ readonly outbound_policy_revision: number; readonly owner_approved: number }>();
        expect(state).toEqual({ outbound_policy_revision: 1, owner_approved: 1 });

        const audit = await env.DIRECTORY_DATABASE.prepare(
            `SELECT COUNT(*) AS count FROM bot_audit_events
              WHERE bot_id = ? AND action = 'bot.delivery_target.approved' AND subject_id = ?`,
        )
            .bind(bot.botId, target.deliveryTargetId)
            .first<{ readonly count: number }>();
        expect(audit?.count).toBe(1);
    });

    it("Given a single-use connection grant and rotating credentials, When a connector replays, rotates, and revokes, Then each credential boundary is independent", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const bot = await pairing.client.createBot(
            { displayName: "Credential boundaries", avatarRef: "", description: "Credential boundaries description" },
            pairing.signal,
        );
        const grant = await createConnectionGrant(pairing, bot, "primary");
        const primary = await redeemConnectionGrant(grant, "primary");

        await expectApiError(
            await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connection-grants/redeem`, {
                body: JSON.stringify({
                    audience: "test-connector",
                    connectorPrincipalId: "principal-primary-replay",
                    grantId: grant.grantId,
                    grantSecret: grant.grantSecret,
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
            401,
            "credential_invalid",
        );

        const rotation = await json(
            await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${primary.connectionId}/credentials/rotate`,
                {
                    body: JSON.stringify({}),
                    headers: connectorHeaders(primary),
                    method: "POST",
                },
            ),
            201,
        );
        const rotated: RedeemedConnection = {
            connectionId: primary.connectionId,
            credential: stringField(rotation, "credential"),
        };
        const overlapTarget = await json(
            await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${primary.connectionId}/delivery-targets`,
                {
                    body: JSON.stringify({ alias: "during-overlap" }),
                    headers: connectorHeaders(primary),
                    method: "POST",
                },
            ),
            201,
        );
        expect(overlapTarget["connectionId"]).toBe(primary.connectionId);

        vi.setSystemTime(new Date("2026-09-08T08:05:00.001Z"));
        await expectApiError(
            await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${primary.connectionId}/outbound-events?after=0`,
                { headers: connectorHeaders(primary) },
            ),
            401,
            "credential_invalid",
        );
        await json(
            await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${rotated.connectionId}/delivery-targets`,
                {
                    body: JSON.stringify({ alias: "after-overlap" }),
                    headers: connectorHeaders(rotated),
                    method: "POST",
                },
            ),
            201,
        );

        const secondary = await connectBot(pairing, bot, "secondary");
        await json(
            await app.request(`${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${rotated.connectionId}/revoke`, {
                body: JSON.stringify({}),
                headers: connectorHeaders(rotated),
                method: "POST",
            }),
            200,
        );
        const revokedOperations = [
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${rotated.connectionId}/outbound-events?after=0`,
                { headers: connectorHeaders(rotated) },
            ),
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${rotated.connectionId}/outbound-messages/out_missing/delivered`,
                {
                    body: JSON.stringify({ claimId: "claim_missing" }),
                    headers: connectorHeaders(rotated),
                    method: "POST",
                },
            ),
            new Request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
                {
                    body: JSON.stringify({
                        clientConversationKey: "revoked-inbound",
                        replyDeliveryTargetId: stringField(overlapTarget, "deliveryTargetId"),
                        title: "Revoked inbound",
                    }),
                    headers: connectorHeaders(rotated),
                    method: "POST",
                },
            ),
        ];
        for (const operation of revokedOperations) {
            await expectApiError(await app.request(operation), 401, "connection_revoked");
        }
        const secondaryTarget = await json(
            await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${secondary.connectionId}/delivery-targets`,
                {
                    body: JSON.stringify({ alias: "secondary-still-active" }),
                    headers: connectorHeaders(secondary),
                    method: "POST",
                },
            ),
            201,
        );
        expect(secondaryTarget["lifecycle"]).toBe("active");
    });

    it("Given two Bots are bound to different Runtimes in one Project, When both execute and one Runtime is revoked, Then delivery remains pinned and the other Bot stays executable", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const runtimeA = await pairRuntime(app);
        const runtimeB = await pairAdditionalRuntime(runtimeA, "secondary");
        const daemonA = await openDaemon(runtimeA);
        const daemonB = await openDaemon(runtimeB);
        try {
            const botA = await runtimeA.client.createBot(
                { displayName: "Runtime A Bot", avatarRef: "", description: "Runtime A Bot description" },
                runtimeA.signal,
            );
            const botB = await runtimeA.client.createBot(
                { displayName: "Runtime B Bot", avatarRef: "", description: "Runtime B Bot description" },
                runtimeA.signal,
            );
            const behaviorA = await runtimeA.client.createBehavior(
                botA.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Runtime A Bot.",
                    requiredCapabilities: ["embedded-context"],
                },
                runtimeA.signal,
            );
            const behaviorB = await runtimeA.client.createBehavior(
                botB.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Runtime B Bot.",
                    requiredCapabilities: ["embedded-context"],
                },
                runtimeA.signal,
            );
            const connectionA = await connectBot(runtimeA, botA, "runtime-a");
            const connectionB = await connectBot(runtimeA, botB, "runtime-b");
            const targetA = await createTarget(runtimeA, botA, connectionA, "runtime-a-target");
            const targetB = await createTarget(runtimeA, botB, connectionB, "runtime-b-target");
            const bindingA = await approveBinding(runtimeA, daemonA, botA, behaviorA, targetA);
            const bindingB = await approveBinding(runtimeB, daemonB, botB, behaviorB, targetB);
            const conversationA = await runtimeA.client.createConversation(
                botA.botId,
                { clientConversationKey: "runtime-a-conversation" },
                runtimeA.signal,
            );
            const conversationB = await runtimeA.client.createConversation(
                botB.botId,
                { clientConversationKey: "runtime-b-conversation" },
                runtimeA.signal,
            );

            const [acceptedA, acceptedB] = await Promise.all([
                runtimeA.client.submitMessage(
                    botA.botId,
                    conversationA.conversationId,
                    {
                        actorRef: "project-owner",
                        artifactIds: [],
                        clientMessageId: "runtime-a-message",
                        text: "Run runtime-a-message",
                    },
                    runtimeA.signal,
                ),
                runtimeA.client.submitMessage(
                    botB.botId,
                    conversationB.conversationId,
                    {
                        actorRef: "project-owner",
                        artifactIds: [],
                        clientMessageId: "runtime-b-message",
                        text: "Run runtime-b-message",
                    },
                    runtimeA.signal,
                ),
            ]);
            const commandA = decodeBotSessionPromptCommand(await daemonA.messages.next());
            const commandB = decodeBotSessionPromptCommand(await daemonB.messages.next());
            expect(commandA).toMatchObject({
                bindingId: bindingA.bindingId,
                bindingRevision: bindingA.bindingRevision,
                botId: botA.botId,
                conversationId: conversationA.conversationId,
                executionId: acceptedA.executionId,
                localGrantId: `grant_${botA.botId}`,
            });
            expect(commandB).toMatchObject({
                bindingId: bindingB.bindingId,
                bindingRevision: bindingB.bindingRevision,
                botId: botB.botId,
                conversationId: conversationB.conversationId,
                executionId: acceptedB.executionId,
                localGrantId: `grant_${botB.botId}`,
            });
            expect(commandA.executionCapabilitySecret).not.toBe(commandB.executionCapabilitySecret);
            expect(commandA.localGrantId).not.toBe(commandB.localGrantId);

            for (const execution of [
                { accepted: acceptedA, command: commandA, daemon: daemonA },
                { accepted: acceptedB, command: commandB, daemon: daemonB },
            ]) {
                const attemptId = `attempt_${execution.command.commandId}`;
                await commitAttemptEvent(
                    execution.daemon,
                    attemptEnvelope(
                        execution.command.sessionId,
                        execution.command.commandId,
                        `event_${execution.command.commandId}_started`,
                        SESSION_STARTED_KIND,
                        attemptId,
                        1,
                    ),
                );
                await commitAttemptEvent(
                    execution.daemon,
                    attemptEnvelope(
                        execution.command.sessionId,
                        execution.command.commandId,
                        `event_${execution.command.commandId}_completed`,
                        SESSION_COMPLETED_KIND,
                        attemptId,
                        2,
                    ),
                );
                expect(execution.accepted.turnId).toBe(execution.command.turnId);
            }
            await expectConversationHistory(runtimeA, botA, conversationA, acceptedA, behaviorA);
            await expectConversationHistory(runtimeA, botB, conversationB, acceptedB, behaviorB);

            daemonA.socket.send(
                encodeSessionEventEnvelope(
                    attemptEnvelope(
                        commandB.sessionId,
                        commandB.commandId,
                        "event_runtime_a_cross_commit",
                        SESSION_COMPLETED_KIND,
                        `attempt_${commandB.commandId}`,
                        3,
                    ),
                ),
            );
            expect(decodeSessionEventRejection(await daemonA.messages.next())).toMatchObject({
                code: SessionEventRejectionCode.SessionRejected,
                eventId: "event_runtime_a_cross_commit",
                sessionId: commandB.sessionId,
            });
            expect(daemonA.socket.readyState).toBe(WebSocket.OPEN);

            const revoked = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/projects/${runtimeA.projectId}/runtimes/${runtimeA.runtimeId}`,
                { headers: ownerHeaders(runtimeA), method: "DELETE" },
            );
            expect(revoked.status).toBe(204);
            const unavailable = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${runtimeA.projectId}/bots/${botA.botId}/conversations/${conversationA.conversationId}/messages`,
                {
                    body: JSON.stringify({
                        actorRef: "project-owner",
                        artifactIds: [],
                        clientMessageId: "runtime-a-after-revoke",
                        text: "Do not fail over",
                    }),
                    headers: ownerHeaders(runtimeA),
                    method: "POST",
                },
            );
            await expectApiError(unavailable, 409, "binding_incompatible");

            const surviving = await runtimeA.client.submitMessage(
                botB.botId,
                conversationB.conversationId,
                {
                    actorRef: "project-owner",
                    artifactIds: [],
                    clientMessageId: "runtime-b-after-revoke",
                    text: "Run runtime-b-after-revoke",
                },
                runtimeA.signal,
            );
            expect(decodeBotSessionPromptCommand(await daemonB.messages.next())).toMatchObject({
                botId: botB.botId,
                executionId: surviving.executionId,
                localGrantId: commandB.localGrantId,
            });
            expect(daemonB.socket.readyState).toBe(WebSocket.OPEN);
        } finally {
            daemonA.socket.close(1000, "Test complete");
            daemonB.socket.close(1000, "Test complete");
        }
    });

    it("Given a Runtime belongs to another Project, When a Bot owner requests a binding to it, Then the request is rejected before a binding or local approval is created", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const owner = await pairRuntime(app);
        const foreign = await pairRuntime(app);
        const bot = await owner.client.createBot(
            { displayName: "Project-isolated Bot", avatarRef: "", description: "Project-isolated Bot description" },
            owner.signal,
        );
        const behavior = await owner.client.createBehavior(
            bot.botId,
            {
                agentConfiguration: {},
                expectedRevision: 0,
                instructions: "You are Project-isolated Bot.",
                requiredCapabilities: ["embedded-context"],
            },
            owner.signal,
        );
        const response = await app.request(
            `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${owner.projectId}/bots/${bot.botId}/execution-bindings`,
            {
                body: JSON.stringify({
                    agentConfigRevision: 1,
                    agentRef: "codex",
                    allowedDeliveryTargetIds: [],
                    behaviorRevisionId: behavior.behaviorRevisionId,
                    completionPolicy: { kind: "none" },
                    executionConfiguration: DEFAULT_AGENT_EXECUTION_CONFIGURATION,
                    expectedRevision: bot.lifecycleRevision,
                    runtimeId: foreign.runtimeId,
                    workspaceRef: "default",
                }),
                headers: ownerHeaders(owner),
                method: "POST",
            },
        );
        await expectApiError(response, 409, "binding_incompatible");
        const bindings = await env.DIRECTORY_DATABASE.prepare(
            `SELECT COUNT(*) AS binding_count FROM bot_execution_bindings WHERE bot_id = ?`,
        )
            .bind(bot.botId)
            .first<{ readonly binding_count: number }>();
        expect(bindings?.binding_count).toBe(0);
    });

    it("Given two Bots share one Runtime and Agent, When both execute and send outbound messages, Then their pinned identities and targets remain isolated", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const botAlpha = await pairing.client.createBot(
                { displayName: "Alpha", avatarRef: "", description: "Alpha description" },
                pairing.signal,
            );
            const botBeta = await pairing.client.createBot(
                { displayName: "Beta", avatarRef: "", description: "Beta description" },
                pairing.signal,
            );
            const behaviorAlpha = await pairing.client.createBehavior(
                botAlpha.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Alpha.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            const behaviorBeta = await pairing.client.createBehavior(
                botBeta.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Beta.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            const connectionAlpha = await connectBot(pairing, botAlpha, "alpha");
            const connectionBeta = await connectBot(pairing, botBeta, "beta");
            const targetAlpha = await createTarget(pairing, botAlpha, connectionAlpha, "alpha-notifications");
            const targetBeta = await createTarget(pairing, botBeta, connectionBeta, "beta-notifications");
            const bindingAlpha = await approveBinding(pairing, daemon, botAlpha, behaviorAlpha, targetAlpha);
            const bindingBeta = await approveBinding(pairing, daemon, botBeta, behaviorBeta, targetBeta);
            const conversationAlpha = await pairing.client.createConversation(
                botAlpha.botId,
                { clientConversationKey: "alpha-thread" },
                pairing.signal,
            );
            const conversationBeta = await pairing.client.createConversation(
                botBeta.botId,
                { clientConversationKey: "beta-thread" },
                pairing.signal,
            );

            expect(conversationAlpha).toMatchObject({
                behaviorRevisionId: behaviorAlpha.behaviorRevisionId,
                bindingRevision: bindingAlpha.bindingRevision,
            });
            expect(conversationBeta).toMatchObject({
                behaviorRevisionId: behaviorBeta.behaviorRevisionId,
                bindingRevision: bindingBeta.bindingRevision,
            });

            const acceptedAlpha = await pairing.client.submitMessage(
                botAlpha.botId,
                conversationAlpha.conversationId,
                {
                    actorRef: "project-owner",
                    artifactIds: [],
                    clientMessageId: "message-alpha",
                    text: "Run message-alpha",
                },
                pairing.signal,
            );
            const acceptedBeta = await pairing.client.submitMessage(
                botBeta.botId,
                conversationBeta.conversationId,
                {
                    actorRef: "project-owner",
                    artifactIds: [],
                    clientMessageId: "message-beta",
                    text: "Run message-beta",
                },
                pairing.signal,
            );
            const commandAlpha = decodeBotSessionPromptCommand(await daemon.messages.next());
            const commandBeta = decodeBotSessionPromptCommand(await daemon.messages.next());
            expect(new Set([commandAlpha.botId, commandBeta.botId])).toEqual(new Set([botAlpha.botId, botBeta.botId]));
            const commands = new Map([
                [commandAlpha.botId, commandAlpha],
                [commandBeta.botId, commandBeta],
            ]);
            const alpha = commands.get(botAlpha.botId);
            const beta = commands.get(botBeta.botId);
            if (alpha === undefined || beta === undefined) {
                throw new Error("Expected both Bot commands");
            }
            expect(alpha).toMatchObject({
                behaviorRevisionId: behaviorAlpha.behaviorRevisionId,
                bindingRevision: bindingAlpha.bindingRevision,
                executionId: acceptedAlpha.executionId,
                turnId: acceptedAlpha.turnId,
            });
            expect(beta).toMatchObject({
                behaviorRevisionId: behaviorBeta.behaviorRevisionId,
                bindingRevision: bindingBeta.bindingRevision,
                executionId: acceptedBeta.executionId,
                turnId: acceptedBeta.turnId,
            });

            const crossBot = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-executions/${alpha.executionId}/delivery-targets/${targetBeta.deliveryTargetId}/messages`,
                {
                    body: JSON.stringify({ idempotencyKey: "cross-bot", text: "forbidden" }),
                    headers: {
                        authorization: `Bearer ${pairing.daemonToken}`,
                        "content-type": "application/json",
                        "x-mobius-bot-execution-capability": alpha.executionCapabilitySecret,
                    },
                    method: "POST",
                },
            );
            expect(crossBot.status).toBe(403);
            await expect(crossBot.json()).resolves.toMatchObject({
                error: { code: "delivery_target_not_allowed" },
            });

            for (const command of [alpha, beta]) {
                const target = command.botId === botAlpha.botId ? targetAlpha : targetBeta;
                const accepted = await json(
                    await app.request(
                        `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-executions/${command.executionId}/delivery-targets/${target.deliveryTargetId}/messages`,
                        {
                            body: JSON.stringify({
                                idempotencyKey: `${command.commandId}-completion`,
                                text: `${command.botId} completed`,
                            }),
                            headers: {
                                authorization: `Bearer ${pairing.daemonToken}`,
                                "content-type": "application/json",
                                "x-mobius-bot-execution-capability": command.executionCapabilitySecret,
                            },
                            method: "POST",
                        },
                    ),
                    202,
                );
                expect(stringField(accepted, "outboundMessageId")).toMatch(/^out_/);
                const attemptId = `attempt_${command.commandId}`;
                await commitAttemptEvent(
                    daemon,
                    attemptEnvelope(
                        command.sessionId,
                        command.commandId,
                        `event_${command.commandId}_started`,
                        SESSION_STARTED_KIND,
                        attemptId,
                        1,
                    ),
                );
                await commitAttemptEvent(
                    daemon,
                    attemptEnvelope(
                        command.sessionId,
                        command.commandId,
                        `event_${command.commandId}_completed`,
                        SESSION_COMPLETED_KIND,
                        attemptId,
                        2,
                    ),
                );
            }

            await expectConversationHistory(pairing, botAlpha, conversationAlpha, acceptedAlpha, behaviorAlpha);
            await expectConversationHistory(pairing, botBeta, conversationBeta, acceptedBeta, behaviorBeta);

            const outboundAlpha = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connectionAlpha.connectionId}/outbound-events?after=0`,
                    { headers: connectorHeaders(connectionAlpha) },
                ),
                200,
            );
            const outboundBeta = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connectionBeta.connectionId}/outbound-events?after=0`,
                    { headers: connectorHeaders(connectionBeta) },
                ),
                200,
            );
            expect(outboundAlpha["events"]).toMatchObject([
                {
                    behaviorRevisionId: behaviorAlpha.behaviorRevisionId,
                    bindingRevision: bindingAlpha.bindingRevision,
                    botId: botAlpha.botId,
                    conversationId: conversationAlpha.conversationId,
                    deliveryTargetId: targetAlpha.deliveryTargetId,
                    executionId: acceptedAlpha.executionId,
                    turnId: acceptedAlpha.turnId,
                },
            ]);
            expect(outboundBeta["events"]).toMatchObject([
                {
                    behaviorRevisionId: behaviorBeta.behaviorRevisionId,
                    bindingRevision: bindingBeta.bindingRevision,
                    botId: botBeta.botId,
                    conversationId: conversationBeta.conversationId,
                    deliveryTargetId: targetBeta.deliveryTargetId,
                    executionId: acceptedBeta.executionId,
                    turnId: acceptedBeta.turnId,
                },
            ]);

            const firstAlphaEvent = recordArrayField(outboundAlpha, "events")[0];
            if (firstAlphaEvent === undefined) {
                throw new Error("Expected the first Alpha outbound event");
            }
            const firstClaimId = stringField(firstAlphaEvent, "claimId");
            const alphaCursor = integerField(outboundAlpha, "cursor");
            const firstBetaEvent = recordArrayField(outboundBeta, "events")[0];
            if (firstBetaEvent === undefined) {
                throw new Error("Expected the first Beta outbound event");
            }
            vi.setSystemTime(new Date("2026-09-08T08:01:00.001Z"));
            const expiredAcknowledgement = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connectionBeta.connectionId}/outbound-messages/${stringField(firstBetaEvent, "outboundMessageId")}/delivered`,
                {
                    body: JSON.stringify({ claimId: stringField(firstBetaEvent, "claimId") }),
                    headers: connectorHeaders(connectionBeta),
                    method: "POST",
                },
            );
            expect(expiredAcknowledgement.status).toBe(409);
            await expect(expiredAcknowledgement.json()).resolves.toMatchObject({
                error: { code: "revision_conflict" },
            });
            const redelivery = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connectionAlpha.connectionId}/outbound-events?after=${alphaCursor.toString()}`,
                    { headers: connectorHeaders(connectionAlpha) },
                ),
                200,
            );
            const redeliveredEvent = recordArrayField(redelivery, "events")[0];
            if (redeliveredEvent === undefined) {
                throw new Error("Expected the unacknowledged Alpha message to be redelivered");
            }
            expect(stringField(redeliveredEvent, "outboundMessageId")).toBe(
                stringField(firstAlphaEvent, "outboundMessageId"),
            );
            const redeliveryClaimId = stringField(redeliveredEvent, "claimId");
            expect(redeliveryClaimId).not.toBe(firstClaimId);

            const staleAcknowledgement = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connectionAlpha.connectionId}/outbound-messages/${stringField(firstAlphaEvent, "outboundMessageId")}/delivered`,
                {
                    body: JSON.stringify({ claimId: firstClaimId }),
                    headers: connectorHeaders(connectionAlpha),
                    method: "POST",
                },
            );
            expect(staleAcknowledgement.status).toBe(409);
            await expect(staleAcknowledgement.json()).resolves.toMatchObject({
                error: { code: "revision_conflict" },
            });

            const retryableFailureUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connectionAlpha.connectionId}/outbound-messages/${stringField(firstAlphaEvent, "outboundMessageId")}/retryable-failure`;
            const retryableBody = JSON.stringify({
                claimId: redeliveryClaimId,
                code: "provider_unavailable",
                retryAfterSeconds: 30,
            });
            const retryable = await json(
                await app.request(retryableFailureUrl, {
                    body: retryableBody,
                    headers: connectorHeaders(connectionAlpha),
                    method: "POST",
                }),
                200,
            );
            expect(retryable).toMatchObject({ duplicate: false, state: "retryable_failed" });
            const duplicateRetryable = await json(
                await app.request(retryableFailureUrl, {
                    body: retryableBody,
                    headers: connectorHeaders(connectionAlpha),
                    method: "POST",
                }),
                200,
            );
            expect(duplicateRetryable).toMatchObject({ duplicate: true, state: "retryable_failed" });

            vi.setSystemTime(new Date("2026-09-08T08:01:30.001Z"));
            const retryDelivery = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connectionAlpha.connectionId}/outbound-events?after=${alphaCursor.toString()}`,
                    { headers: connectorHeaders(connectionAlpha) },
                ),
                200,
            );
            const retryEvent = recordArrayField(retryDelivery, "events")[0];
            if (retryEvent === undefined) {
                throw new Error("Expected the retryable Alpha message to become available");
            }
            const deliveredUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connectionAlpha.connectionId}/outbound-messages/${stringField(retryEvent, "outboundMessageId")}/delivered`;
            const deliveredBody = JSON.stringify({ claimId: stringField(retryEvent, "claimId") });
            const delivered = await json(
                await app.request(deliveredUrl, {
                    body: deliveredBody,
                    headers: connectorHeaders(connectionAlpha),
                    method: "POST",
                }),
                200,
            );
            expect(delivered).toMatchObject({ duplicate: false, state: "delivered" });
            const duplicateDelivered = await json(
                await app.request(deliveredUrl, {
                    body: deliveredBody,
                    headers: connectorHeaders(connectionAlpha),
                    method: "POST",
                }),
                200,
            );
            expect(duplicateDelivered).toMatchObject({ duplicate: true, state: "delivered" });
        } finally {
            daemon.socket.close(1000, "Test complete");
        }
    });

    it("Given a Bot execution with an invalid persisted quota counter, When its runtime submits an outbound message, Then storage rejects the message without delivering it", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const bot = await pairing.client.createBot(
                { displayName: "Invalid quota", avatarRef: "", description: "Invalid quota description" },
                pairing.signal,
            );
            const connection = await connectBot(pairing, bot, "invalid-quota");
            const target = await createTarget(pairing, bot, connection, "notifications");
            const behavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Invalid quota.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            await approveBinding(pairing, daemon, bot, behavior, target, bot.lifecycleRevision);
            const conversation = await pairing.client.createConversation(
                bot.botId,
                { clientConversationKey: "invalid-quota" },
                pairing.signal,
            );
            await pairing.client.submitMessage(
                bot.botId,
                conversation.conversationId,
                {
                    actorRef: "project-owner",
                    artifactIds: [],
                    clientMessageId: "invalid-quota-message",
                    text: "Run invalid-quota-message",
                },
                pairing.signal,
            );
            const command = decodeBotSessionPromptCommand(await daemon.messages.next());
            const session = env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(`${env.MOBIUS_TENANT_ID}:${pairing.projectId}:${command.sessionId}`),
            );
            await runInDurableObject(session, (_instance, state) => {
                state.storage.sql.exec(
                    "UPDATE bot_execution_capabilities SET usage_count = -1 WHERE execution_id = ?",
                    command.executionId,
                );
            });
            await expectApiError(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-executions/${command.executionId}/delivery-targets/${target.deliveryTargetId}/messages`,
                    {
                        method: "POST",
                        headers: executionHeaders(pairing, command.executionCapabilitySecret),
                        body: JSON.stringify({
                            idempotencyKey: "invalid-quota-outbound",
                            text: "Must not be delivered",
                        }),
                    },
                ),
                503,
                "session_storage_unavailable",
            );
            const outbound = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connection.connectionId}/outbound-events?after=0`,
                    { headers: connectorHeaders(connection) },
                ),
                200,
            );
            expect(recordArrayField(outbound, "events")).toEqual([]);
        } finally {
            daemon.socket.close(1000, "Test complete");
        }
    });

    it("Given idempotent inbound and outbound work with a required completion policy, When a turn completes and the Bot is suspended, Then work is created once, capabilities expire, and audit records remain singular", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const bot = await pairing.client.createBot(
                {
                    displayName: "Idempotent completion",
                    avatarRef: "",
                    description: "Idempotent completion description",
                },
                pairing.signal,
            );
            const connection = await connectBot(pairing, bot, "idempotent-completion");
            const target = await createTarget(pairing, bot, connection, "completion-notifications");
            const behavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Idempotent completion.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            const binding = await approveBinding(pairing, daemon, bot, behavior, target, bot.lifecycleRevision, {
                deliveryTargetId: target.deliveryTargetId,
                kind: "required",
                messageTemplate: "Turn {status}",
            });
            const conversation = await pairing.client.createConversation(
                bot.botId,
                { clientConversationKey: "idempotent-completion" },
                pairing.signal,
            );

            const first = await pairing.client.submitMessage(
                bot.botId,
                conversation.conversationId,
                {
                    actorRef: "project-owner",
                    artifactIds: [],
                    clientMessageId: "message-once",
                    text: "Run message-once",
                },
                pairing.signal,
            );
            const command = decodeBotSessionPromptCommand(await daemon.messages.next());
            const duplicate = await pairing.client.submitMessage(
                bot.botId,
                conversation.conversationId,
                {
                    actorRef: "project-owner",
                    artifactIds: [],
                    clientMessageId: "message-once",
                    text: "Run message-once",
                },
                pairing.signal,
            );
            expect(first.duplicate).toBe(false);
            expect(duplicate).toEqual({ ...first, duplicate: true });

            const executionCount = await env.DIRECTORY_DATABASE.prepare(
                `SELECT COUNT(*) AS count FROM bot_execution_directory
                  WHERE bot_id = ? AND conversation_id = ? AND turn_id = ?`,
            )
                .bind(bot.botId, conversation.conversationId, first.turnId)
                .first<{ readonly count: number }>();
            expect(executionCount?.count).toBe(1);

            const changedInbound = await app.request(
                `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations/${conversation.conversationId}/messages`,
                {
                    body: JSON.stringify({
                        actorRef: "project-owner",
                        artifactIds: [],
                        clientMessageId: "message-once",
                        text: "Different content",
                    }),
                    headers: ownerHeaders(pairing),
                    method: "POST",
                },
            );
            await expectApiError(changedInbound, 409, "idempotency_conflict");

            const outboundUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-executions/${command.executionId}/delivery-targets/${target.deliveryTargetId}/messages`;
            const outboundBody = JSON.stringify({ idempotencyKey: "manual-once", text: "Manual notification" });
            const firstOutbound = await json(
                await app.request(outboundUrl, {
                    body: outboundBody,
                    headers: executionHeaders(pairing, command.executionCapabilitySecret),
                    method: "POST",
                }),
                202,
            );
            const duplicateOutbound = await json(
                await app.request(outboundUrl, {
                    body: outboundBody,
                    headers: executionHeaders(pairing, command.executionCapabilitySecret),
                    method: "POST",
                }),
                202,
            );
            expect(firstOutbound["duplicate"]).toBe(false);
            expect(duplicateOutbound).toEqual({
                duplicate: true,
                outboundMessageId: stringField(firstOutbound, "outboundMessageId"),
            });
            await expectApiError(
                await app.request(outboundUrl, {
                    body: JSON.stringify({ idempotencyKey: "manual-once", text: "Changed notification" }),
                    headers: executionHeaders(pairing, command.executionCapabilitySecret),
                    method: "POST",
                }),
                409,
                "idempotency_conflict",
            );

            const attemptId = "attempt-idempotent-completion";
            await commitAttemptEvent(
                daemon,
                attemptEnvelope(
                    command.sessionId,
                    command.commandId,
                    "event-idempotent-started",
                    SESSION_STARTED_KIND,
                    attemptId,
                    1,
                ),
            );
            const completion = attemptEnvelope(
                command.sessionId,
                command.commandId,
                "event-idempotent-completed",
                SESSION_COMPLETED_KIND,
                attemptId,
                2,
            );
            await commitAttemptEvent(daemon, completion);
            daemon.socket.send(encodeSessionEventEnvelope(completion));
            expect(decodeSessionEventAcknowledgement(await daemon.messages.next())).toMatchObject({
                duplicate: true,
                eventId: completion.eventId,
            });

            const outbound = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/bot-connections/${connection.connectionId}/outbound-events?after=0`,
                    { headers: connectorHeaders(connection) },
                ),
                200,
            );
            const outboundEvents = recordArrayField(outbound, "events");
            expect(outboundEvents).toHaveLength(2);
            expect(outboundEvents.map((event) => event["idempotencyKey"]).sort()).toEqual([
                `completion:${first.turnId}`,
                "manual-once",
            ]);
            expect(
                outboundEvents.find((event) => event["idempotencyKey"] === `completion:${first.turnId}`),
            ).toMatchObject({
                behaviorRevisionId: behavior.behaviorRevisionId,
                bindingId: binding.bindingId,
                bindingRevision: binding.bindingRevision,
                botId: bot.botId,
                conversationId: conversation.conversationId,
                deliveryTargetId: target.deliveryTargetId,
                executionId: first.executionId,
                text: "Turn completed",
                turnId: first.turnId,
            });

            await expectApiError(
                await app.request(outboundUrl, {
                    body: JSON.stringify({ idempotencyKey: "after-completion", text: "Too late" }),
                    headers: executionHeaders(pairing, command.executionCapabilitySecret),
                    method: "POST",
                }),
                410,
                "execution_capability_expired",
            );

            await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/suspend`,
                    {
                        body: JSON.stringify({ expectedRevision: 2 }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                200,
            );
            await expectApiError(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations/${conversation.conversationId}/messages`,
                    {
                        body: JSON.stringify({
                            actorRef: "project-owner",
                            artifactIds: [],
                            clientMessageId: "while-suspended",
                            text: "Must not run",
                        }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                409,
                "bot_suspended",
            );

            const audits = await env.DIRECTORY_DATABASE.prepare(
                `SELECT action, COUNT(*) AS count FROM bot_audit_events
                  WHERE bot_id = ? AND action IN (
                    'bot.execution.created', 'bot.outbound.accepted', 'bot.suspended'
                  ) GROUP BY action ORDER BY action`,
            )
                .bind(bot.botId)
                .all<{ readonly action: string; readonly count: number }>();
            expect(audits.results).toEqual([
                { action: "bot.execution.created", count: 1 },
                { action: "bot.outbound.accepted", count: 1 },
                { action: "bot.suspended", count: 1 },
            ]);
        } finally {
            daemon.socket.close(1000, "Test complete");
        }
    });

    it("Given a connected conversation emits local Agent activity, When owner and connector principals resume the event stream, Then connector output is sanitized and actor claims never widen scopes", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const bot = await pairing.client.createBot(
                { displayName: "Sanitized events", avatarRef: "", description: "Sanitized events description" },
                pairing.signal,
            );
            const connection = await connectBot(pairing, bot, "sanitized-events");
            const limited = await connectBot(pairing, bot, "limited-events", ["conversation-events:read"]);
            const target = await createTarget(pairing, bot, connection, "reply-target");
            const behavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Sanitized events.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            await approveBinding(pairing, daemon, bot, behavior, target);
            const conversation = await createConnectedConversation(pairing, bot, connection, target, "external-thread");

            await expectApiError(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations/${conversation.conversationId}/messages`,
                    {
                        body: JSON.stringify({
                            actorRef: "project-owner-administrator",
                            clientMessageId: "limited-actor-claim",
                            resourceRefs: [],
                            text: "Claim owner authority",
                        }),
                        headers: connectorHeaders(limited),
                        method: "POST",
                    },
                ),
                403,
                "scope_denied",
            );

            const accepted = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations/${conversation.conversationId}/messages`,
                    {
                        body: JSON.stringify({
                            actorRef: "external-user-42",
                            clientMessageId: "external-message",
                            resourceRefs: [],
                            text: "Inspect a private file",
                        }),
                        headers: connectorHeaders(connection),
                        method: "POST",
                    },
                ),
                202,
            );
            const command = decodeBotSessionPromptCommand(await daemon.messages.next());
            const attemptId = "attempt-sanitized-events";
            await commitAttemptEvent(
                daemon,
                attemptEnvelope(
                    command.sessionId,
                    command.commandId,
                    "event-sanitized-started",
                    SESSION_STARTED_KIND,
                    attemptId,
                    1,
                ),
            );
            await commitAttemptEvent(
                daemon,
                activityEnvelope(command.sessionId, command.commandId, attemptId, "event-sensitive-activity", 2),
            );

            const eventUrl = `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations/${conversation.conversationId}/events`;
            const ownerPage = await json(await app.request(eventUrl, { headers: ownerHeaders(pairing) }), 200);
            const connectorPage = await json(
                await app.request(eventUrl, { headers: connectorHeaders(connection) }),
                200,
            );
            const ownerActivity = recordArrayField(ownerPage, "events").find(
                (event) => event["kind"] === AGENT_ACTIVITY_KIND,
            );
            const connectorActivity = recordArrayField(connectorPage, "events").find(
                (event) => event["kind"] === AGENT_ACTIVITY_KIND,
            );
            expect(ownerActivity).toMatchObject({
                conversationId: conversation.conversationId,
                payload: {
                    input: '{"path":"/private/workspace/secret.txt"}',
                    locations: ["/private/workspace/secret.txt"],
                    output: "private result",
                },
                turnId: stringField(accepted, "turnId"),
            });
            expect(connectorActivity).toMatchObject({
                conversationId: conversation.conversationId,
                payload: { kind: AGENT_ACTIVITY_KIND },
                turnId: stringField(accepted, "turnId"),
            });
            expect(Object.keys(record(record(connectorActivity)["payload"]))).toEqual(["kind"]);
        } finally {
            daemon.socket.close(1000, "Test complete");
        }
    });

    it("Given an approved Runtime is temporarily offline, When an inbound Bot message is accepted, Then reconnect dispatches the same durable turn once", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        const recoveredSockets: OpenSocket[] = [];
        try {
            const bot = await pairing.client.createBot(
                { displayName: "Offline Runtime", avatarRef: "", description: "Offline Runtime description" },
                pairing.signal,
            );
            const connection = await connectBot(pairing, bot, "offline-runtime");
            const target = await createTarget(pairing, bot, connection, "offline-runtime-target");
            const behavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Offline Runtime.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            await approveBinding(pairing, daemon, bot, behavior, target);
            const conversation = await pairing.client.createConversation(
                bot.botId,
                { clientConversationKey: "offline-runtime" },
                pairing.signal,
            );
            daemon.socket.close(1000, "Runtime offline");

            const accepted = await pairing.client.submitMessage(
                bot.botId,
                conversation.conversationId,
                {
                    actorRef: "project-owner",
                    artifactIds: [],
                    clientMessageId: "queued-while-offline",
                    text: "Run queued-while-offline",
                },
                pairing.signal,
            );
            expect(accepted.duplicate).toBe(false);
            const recovered = await openDaemon(pairing);
            recoveredSockets.push(recovered);
            const command = decodeBotSessionPromptCommand(await recovered.messages.next());
            expect(command).toMatchObject({
                behaviorRevisionId: behavior.behaviorRevisionId,
                bindingId: conversation.bindingId,
                bindingRevision: conversation.bindingRevision,
                botId: bot.botId,
                conversationId: conversation.conversationId,
                executionId: accepted.executionId,
                turnId: accepted.turnId,
            });

            const replayed = await pairing.client.submitMessage(
                bot.botId,
                conversation.conversationId,
                {
                    actorRef: "project-owner",
                    artifactIds: [],
                    clientMessageId: "queued-while-offline",
                    text: "Run queued-while-offline",
                },
                pairing.signal,
            );
            expect(replayed).toEqual({ ...accepted, duplicate: true });
            const directory = await env.DIRECTORY_DATABASE.prepare(
                `SELECT COUNT(*) AS count FROM bot_execution_directory
                  WHERE execution_id = ? AND conversation_id = ?`,
            )
                .bind(accepted.executionId, conversation.conversationId)
                .first<{ readonly count: number }>();
            expect(directory?.count).toBe(1);
        } finally {
            for (const recovered of recoveredSockets) {
                recovered.socket.close(1000, "Test complete");
            }
            daemon.socket.close(1000, "Test complete");
        }
    });

    it("Given an existing conversation predates a newly approved behavior, When its creation key is replayed, Then the original session and revisions remain pinned", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const bot = await pairing.client.createBot(
                { displayName: "Pinned", avatarRef: "", description: "Pinned description" },
                pairing.signal,
            );
            const connection = await connectBot(pairing, bot, "pinned");
            const target = await createTarget(pairing, bot, connection, "pinned-notifications");
            const firstBehavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Pinned revision one.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            const firstBinding = await approveBinding(pairing, daemon, bot, firstBehavior, target);
            const original = await pairing.client.createConversation(
                bot.botId,
                { clientConversationKey: "stable-conversation" },
                pairing.signal,
            );

            const secondBehavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 1,
                    instructions: "You are Pinned revision two.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            await approveBinding(pairing, daemon, bot, secondBehavior, target, 2);

            const replayed = await json(
                await app.request(
                    `${relayOrigin}${MOBIUS_API_PREFIX}/v1/projects/${pairing.projectId}/bots/${bot.botId}/conversations`,
                    {
                        body: JSON.stringify({ clientConversationKey: "stable-conversation" }),
                        headers: ownerHeaders(pairing),
                        method: "POST",
                    },
                ),
                201,
            );
            expect(replayed).toMatchObject({
                behaviorRevisionId: firstBehavior.behaviorRevisionId,
                bindingId: firstBinding.bindingId,
                bindingRevision: firstBinding.bindingRevision,
                conversationId: original.conversationId,
                lifecycle: "active",
                sessionId: original.sessionId,
            });
        } finally {
            daemon.socket.close(1000, "Test complete");
        }
    });

    it("Given conversation provisioning was interrupted after Session creation, When the Runtime reconnects, Then the same conversation activates without another session", async () => {
        const app = createTestMobiusApp({ bindings: testBindings() }, createStandaloneGateways);
        const pairing = await pairRuntime(app);
        const daemon = await openDaemon(pairing);
        try {
            const bot = await pairing.client.createBot(
                { displayName: "Recoverable", avatarRef: "", description: "Recoverable description" },
                pairing.signal,
            );
            const connection = await connectBot(pairing, bot, "recoverable");
            const target = await createTarget(pairing, bot, connection, "recoverable-notifications");
            const behavior = await pairing.client.createBehavior(
                bot.botId,
                {
                    agentConfiguration: {},
                    expectedRevision: 0,
                    instructions: "You are Recoverable.",
                    requiredCapabilities: ["embedded-context"],
                },
                pairing.signal,
            );
            await approveBinding(pairing, daemon, bot, behavior, target);
            const conversation = await pairing.client.createConversation(
                bot.botId,
                { clientConversationKey: "recoverable-conversation" },
                pairing.signal,
            );

            const reset = await env.DIRECTORY_DATABASE.batch([
                env.DIRECTORY_DATABASE.prepare(
                    `UPDATE bot_conversations
                        SET lifecycle = 'provisioning', activated_at = NULL
                      WHERE conversation_id = ?`,
                ).bind(conversation.conversationId),
                env.DIRECTORY_DATABASE.prepare(
                    `UPDATE bot_control_outbox
                        SET state = 'pending', completed_at = NULL
                      WHERE subject_id = ? AND message_kind = 'conversation_provisioning'`,
                ).bind(conversation.conversationId),
            ]);
            expect(reset.every((result) => result.meta.changes === 1)).toBe(true);

            const recoveredDaemon = await openDaemon(pairing);
            try {
                const recovered = await env.DIRECTORY_DATABASE.prepare(
                    `SELECT conversations.lifecycle,
                        (SELECT state FROM bot_control_outbox
                          WHERE subject_id = conversations.conversation_id
                            AND message_kind = 'conversation_provisioning') AS outbox_state,
                        (SELECT COUNT(*) FROM bot_conversations
                          WHERE session_id = conversations.session_id) AS session_count
                   FROM bot_conversations AS conversations
                  WHERE conversation_id = ?`,
                )
                    .bind(conversation.conversationId)
                    .first<{
                        readonly lifecycle: string;
                        readonly outbox_state: string;
                        readonly session_count: number;
                    }>();
                expect(recovered).toEqual({ lifecycle: "active", outbox_state: "completed", session_count: 1 });
            } finally {
                recoveredDaemon.socket.close(1000, "Test complete");
            }
        } finally {
            daemon.socket.close(1000, "Test complete");
        }
    });
});
