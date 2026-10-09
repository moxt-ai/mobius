import {
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    encodeAgentMessageDeltaEvent,
    encodeDaemonToServiceMessage,
    encodeSessionCompletedEvent,
    encodeSessionReadyEvent,
    encodeSessionStartedEvent,
    MOBIUS_API_PREFIX,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    type SessionCapabilities,
    type SessionConfigOption,
    type SessionPrepareCommand,
    type SessionPromptCommand,
    type SessionReadyEvent,
} from "@moxt-ai/mobius-protocol";
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, beforeAll, expect } from "vitest";
import { App } from "@/app";
import type { AgentOption, ChannelConnection, InstallableAgentOption } from "@/domain/channel";
import { MobiusChat } from "@/index";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { startLocalRelay } from "./relay-harness.ts";
import { type AgentDaemonSocket, FakeAgentDaemon, FakeAgentDaemonState } from "./support/daemon/connection.ts";

export function createTestApplication() {
    const application = render(createElement(App));
    return {
        destroy: async (): Promise<void> => {
            application.unmount();
        },
    } as const;
}

export function createEmbeddedTestApplication(connection: ChannelConnection) {
    const application = render(createElement(MobiusChat, { connection }));
    return {
        destroy: async (): Promise<void> => {
            application.unmount();
        },
    } as const;
}

interface CreatedPairing {
    readonly channelId: string;
    readonly hostToken: string;
    readonly pairingCode: string;
    readonly projectId: string;
    readonly runtimeId: string;
}

const ASYNC_UI_TIMEOUT_MS = 8_000;

configure({ asyncUtilTimeout: ASYNC_UI_TIMEOUT_MS });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setHappyDomUrl(url: URL): void {
    const api: unknown = Reflect.get(window, "happyDOM");
    if (!isRecord(api)) {
        throw new Error("The Web integration test requires Happy DOM");
    }
    const setURL = api["setURL"];
    if (typeof setURL !== "function") {
        throw new Error("The Happy DOM environment cannot change its URL");
    }
    Reflect.apply(setURL, api, [url.href]);
}

export async function waitForDocumentState(predicate: () => boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (predicate()) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const observer = new MutationObserver(() => evaluate());
        const cleanup = (): void => {
            observer.disconnect();
            signal.removeEventListener("abort", abort);
        };
        const abort = (): void => {
            cleanup();
            reject(signal.reason);
        };
        const evaluate = (): void => {
            try {
                if (!predicate()) {
                    return;
                }
                cleanup();
                resolve();
            } catch (error) {
                cleanup();
                reject(error);
            }
        };
        observer.observe(document.body, {
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
        });
        signal.addEventListener("abort", abort, { once: true });
        evaluate();
    });
}

export interface PairDaemonOptions {
    readonly agentSettingsDiscovery?: boolean;
    readonly agents?: readonly AgentOption[];
    readonly installableAgents?: readonly InstallableAgentOption[];
    readonly sessionTurnConfiguration?: boolean;
}

export async function pairDaemon(options: PairDaemonOptions = {}): Promise<{
    readonly channelId: string;
    readonly close: () => Promise<void>;
    readonly credential: CreatedPairing;
    readonly daemon: FakeAgentDaemon;
    readonly reconnectDaemon: () => Promise<FakeAgentDaemon>;
}> {
    const projectResponse = await fetch(
        new URL(`${MOBIUS_API_PREFIX}/v1/standalone/projects`, window.location.origin),
        { method: "POST" },
    );
    expect(projectResponse.status).toBe(201);
    const project: unknown = await projectResponse.json();
    if (!isRecord(project) || typeof project["projectId"] !== "string" || typeof project["token"] !== "string") {
        throw new Error("Invalid project bootstrap");
    }
    const projectId = project["projectId"];
    const hostToken = project["token"];
    const configuration = await fetch(
        new URL(`${MOBIUS_API_PREFIX}/v1/projects/${projectId}/recording`, window.location.origin),
        {
            body: JSON.stringify({ enabled: false }),
            method: "PUT",
            headers: { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
        },
    );
    expect(configuration.status).toBe(200);
    const createdResponse = await fetch(
        new URL(`${MOBIUS_API_PREFIX}/v1/projects/${projectId}/runtime-pairings`, window.location.origin),
        {
            body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
            method: "POST",
            headers: { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
        },
    );
    expect(createdResponse.status).toBe(201);
    const pairing: unknown = await createdResponse.json();
    if (!isRecord(pairing) || typeof pairing["pairingId"] !== "string" || typeof pairing["pairingCode"] !== "string") {
        throw new Error("Invalid Runtime pairing");
    }
    const claimResponse = await fetch(
        new URL(`${MOBIUS_API_PREFIX}/v1/runtime-pairings/${pairing["pairingId"]}/redeem`, window.location.origin),
        {
            body: JSON.stringify({
                agents: options.agents?.map((agent) => ({
                    ...agent,
                    ...(options.agentSettingsDiscovery === true ? { agentSettingsDiscovery: true } : {}),
                    ...(options.sessionTurnConfiguration === true ? { sessionTurnConfiguration: true } : {}),
                })) ?? [
                    {
                        agentPath: "/usr/local/bin/codex",
                        agentVersion: "codex 0.153.0",
                        ...(options.agentSettingsDiscovery === true ? { agentSettingsDiscovery: true } : {}),
                        ...(options.sessionTurnConfiguration === true ? { sessionTurnConfiguration: true } : {}),
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
                ],
                installableAgents: options.installableAgents ?? [],
                machineName: "Integration machine",
                pairingCode: pairing["pairingCode"],
                workspaceName: "mobius",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        },
    );
    expect(claimResponse.status).toBe(200);
    const redeemed: unknown = await claimResponse.json();
    if (
        !isRecord(redeemed) ||
        typeof redeemed["channelId"] !== "string" ||
        typeof redeemed["runtimeCredential"] !== "string" ||
        typeof redeemed["runtimeId"] !== "string"
    ) {
        throw new Error("Invalid redeemed Runtime");
    }
    const claimed = { channelId: redeemed["channelId"], daemonToken: redeemed["runtimeCredential"] };
    const created = {
        channelId: claimed.channelId,
        projectId,
        hostToken,
        pairingCode: pairing["pairingCode"],
        runtimeId: redeemed["runtimeId"],
    };
    const daemonUrl = new URL(`${MOBIUS_API_PREFIX}/channels/${claimed.channelId}/daemon`, window.location.origin);
    daemonUrl.protocol = "ws:";
    daemonUrl.searchParams.set("token", claimed.daemonToken);
    // A reconnecting Runtime keeps the event-source state it already reported, because the Relay only
    // accepts contiguous source sequences for a source it has recorded.
    const daemonState = new FakeAgentDaemonState();
    const reconnectDaemon = async (): Promise<FakeAgentDaemon> =>
        await FakeAgentDaemon.connect(
            daemonUrl,
            (url) => new WebSocket(url) as unknown as AgentDaemonSocket,
            undefined,
            daemonState,
        );
    const daemon = await reconnectDaemon();
    return {
        channelId: claimed.channelId,
        close: async (): Promise<void> => {
            cleanup();
            await closeMobiusTransport();
            daemon.close();
        },
        credential: created,
        daemon,
        reconnectDaemon,
    };
}

export interface OpenPairedApplicationOptions extends PairDaemonOptions {
    readonly path?: (channelId: string) => string;
}

export async function openPairedApplication(options: OpenPairedApplicationOptions = {}) {
    const { path, ...pairingOptions } = options;
    const paired = await pairDaemon(pairingOptions);
    window.history.replaceState(
        null,
        "",
        path?.(paired.channelId) ?? `/projects/${paired.credential.projectId}/runtimes/${paired.credential.runtimeId}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    createTestApplication();
    return paired;
}

export async function openReadyApplication(options: OpenPairedApplicationOptions = {}) {
    const paired = await openPairedApplication(options);
    try {
        const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
        await sendReadySession(paired.daemon, preparation);
        return { ...paired, preparation } as const;
    } catch (error) {
        await paired.close();
        throw error;
    }
}

export function saveBrowserCredential(channelId: string, credential: CreatedPairing): void {
    expect(credential.channelId).toBe(channelId);
    window.localStorage.setItem(
        `mobius:channel-credential:${channelId}`,
        JSON.stringify({
            authority: "owner",
            hostToken: credential.hostToken,
            projectId: credential.projectId,
        }),
    );
    window.localStorage.setItem(
        `mobius:project-owner-credential:${credential.projectId}`,
        JSON.stringify({
            hostToken: credential.hostToken,
            ownerChannelId: channelId,
            authority: "standalone-project-owner",
            projectId: credential.projectId,
        }),
    );
}

export async function sendReadySession(
    daemon: FakeAgentDaemon,
    prepare: SessionPrepareCommand,
    configOptions: readonly SessionConfigOption[] = [],
    capabilities: SessionCapabilities = {
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
        unstableForkSession: true,
    },
): Promise<void> {
    const ready: SessionReadyEvent = {
        additionalDirectories: prepare.additionalDirectoryIds.map((directoryId) => ({
            directoryId,
            name: directoryId,
        })),
        agentId: prepare.agentId,
        agentName: "Codex",
        agentVersion: "integration",
        capabilities,
        commands: [],
        configOptions,
        directoryId: prepare.directoryId,
        directoryLabel: "mobius",
        kind: "session.ready",
        requestId: prepare.requestId,
        restored: false,
        sessionId: prepare.sessionId,
    };
    if (prepare.transient === true) {
        // The real daemon answers an inspection-only preparation with a direct reply, because the Relay
        // holds no Session for it and could never commit the event. Waiting for an acknowledgement here
        // would hang the test on a message the Relay never accepts.
        daemon.send(encodeDaemonToServiceMessage(ready));
        return;
    }
    await daemon.sendSessionEvent(prepare.sessionId, encodeSessionReadyEvent(ready));
}

export async function completeRenderedPrompt(
    daemon: FakeAgentDaemon,
    promptText: string,
    responseText: string,
    renderedText: string = responseText,
): Promise<SessionPromptCommand> {
    const promptInput = await screen.findByRole("combobox", {
        name: "Message the local agent",
    });
    await waitFor(() => {
        expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
    });
    fireEvent.change(promptInput, { target: { value: promptText } });
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(sendButton);
    const prompt = decodeSessionPromptCommand(await daemon.receive(SESSION_PROMPT_KIND));
    const epoch = crypto.randomUUID();
    await daemon.sendSessionEvent(
        prompt.sessionId,
        encodeSessionStartedEvent({
            commandId: prompt.commandId,
            epoch,
            prompt: prompt.prompt,
            sequence: 0,
            kind: "session.started",
            attemptId: crypto.randomUUID(),
            sessionId: prompt.sessionId,
        }),
    );
    await daemon.sendSessionEvent(
        prompt.sessionId,
        encodeAgentMessageDeltaEvent({
            commandId: prompt.commandId,
            kind: "agent.message.delta",
            epoch,
            sequence: 1,
            messageId: `agent-${prompt.commandId}`,
            sessionId: prompt.sessionId,
            text: responseText,
        }),
    );
    await daemon.sendSessionEvent(
        prompt.sessionId,
        encodeSessionCompletedEvent({
            commandId: prompt.commandId,
            kind: "session.completed",
            sessionId: prompt.sessionId,
            stopReason: "end_turn",
        }),
    );
    await screen.findAllByText(renderedText);
    return prompt;
}

export interface WebIntegrationEnvironment {
    readonly evictRuntime: (channelId: string) => Promise<void>;
}

export function setupWebIntegrationEnvironment(): WebIntegrationEnvironment {
    let closeRelay = (): Promise<void> => Promise.resolve();
    let evictRuntime = (_channelId: string): Promise<void> =>
        Promise.reject(new Error("The Web integration relay is not running"));

    beforeAll(async () => {
        const relay = await startLocalRelay();
        closeRelay = relay.close;
        evictRuntime = relay.evictRuntime;
        setHappyDomUrl(relay.url);
    });

    afterAll(async () => {
        cleanup();
        await closeMobiusTransport();
        await closeRelay();
    });

    return {
        evictRuntime: async (channelId) => await evictRuntime(channelId),
    };
}
