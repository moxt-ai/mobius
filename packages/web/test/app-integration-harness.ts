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
import { type AgentDaemonSocket, FakeAgentDaemon } from "@moxt-ai/mobius-test/agent-daemon";
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, beforeAll, expect } from "vitest";
import { App } from "@/app";
import type { AgentOption, ChannelConnection, InstallableAgentOption } from "@/domain/channel";
import { MobiusChat } from "@/index";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { startLocalRelay } from "./relay-harness.ts";

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
}

interface ClaimedPairing {
    readonly channelId: string;
    readonly daemonToken: string;
}

const ASYNC_UI_TIMEOUT_MS = 8_000;

configure({ asyncUtilTimeout: ASYNC_UI_TIMEOUT_MS });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCreatedPairing(value: unknown): CreatedPairing {
    if (
        !isRecord(value) ||
        typeof value["channelId"] !== "string" ||
        typeof value["hostToken"] !== "string" ||
        typeof value["pairingCode"] !== "string" ||
        typeof value["projectId"] !== "string" ||
        Object.hasOwn(value, "tenantId")
    ) {
        throw new Error("The relay returned invalid browser pairing credentials");
    }
    return {
        channelId: value["channelId"],
        hostToken: value["hostToken"],
        pairingCode: value["pairingCode"],
        projectId: value["projectId"],
    };
}

function decodeClaimedPairing(value: unknown): ClaimedPairing {
    if (!isRecord(value) || typeof value["channelId"] !== "string" || typeof value["daemonToken"] !== "string") {
        throw new Error("The relay returned invalid daemon pairing credentials");
    }
    return {
        channelId: value["channelId"],
        daemonToken: value["daemonToken"],
    };
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
    const createdResponse = await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings`, window.location.origin), {
        method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const created = decodeCreatedPairing(await createdResponse.json());
    const claimResponse = await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings/claim`, window.location.origin), {
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
            pairingCode: created.pairingCode,
            workspaceName: "mobius",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
    });
    expect(claimResponse.status).toBe(200);
    const claimed = decodeClaimedPairing(await claimResponse.json());
    const daemonUrl = new URL(`${MOBIUS_API_PREFIX}/channels/${claimed.channelId}/daemon`, window.location.origin);
    daemonUrl.protocol = "ws:";
    daemonUrl.searchParams.set("token", claimed.daemonToken);
    const reconnectDaemon = async (): Promise<FakeAgentDaemon> =>
        await FakeAgentDaemon.connect(daemonUrl, (url) => new WebSocket(url) as unknown as AgentDaemonSocket);
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
        path?.(paired.channelId) ?? `/channels/${encodeURIComponent(paired.channelId)}`,
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
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const prompt = decodeSessionPromptCommand(await daemon.receive(SESSION_PROMPT_KIND));
    await daemon.sendSessionEvent(
        prompt.sessionId,
        encodeSessionStartedEvent({
            commandId: prompt.commandId,
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
