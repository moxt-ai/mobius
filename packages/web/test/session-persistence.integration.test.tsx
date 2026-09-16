import {
    decodeSessionConfigureCommand,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    decodeWorkspaceListCommand,
    encodeSessionCompletedEvent,
    encodeSessionConfigUpdatedEvent,
    encodeSessionInfoUpdatedEvent,
    encodeSessionStartedEvent,
    encodeWorkspaceEntriesEvent,
    SESSION_CONFIGURE_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    type SessionConfigOption,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "@/app";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { readChannelHistory } from "@/services/pairing-api";
import { useChatStore } from "@/store/chat-store";
import {
    completeRenderedPrompt,
    pairDaemon,
    saveBrowserCredential,
    sendReadySession,
    setupWebIntegrationEnvironment,
    waitForDocumentState,
} from "./app-integration-harness.ts";

const environment = setupWebIntegrationEnvironment();

function modelConfigOptions(model: string): readonly SessionConfigOption[] {
    return [
        {
            booleanValue: false,
            category: "model",
            currentValue: model,
            description: "Execution model",
            id: "model",
            name: "Model",
            type: "select",
            values: [
                {
                    description: "Faster model",
                    groupId: "models",
                    groupName: "Models",
                    name: "Test Small",
                    value: "test-small",
                },
                {
                    description: "More capable model",
                    groupId: "models",
                    groupName: "Models",
                    name: "Test Large",
                    value: "test-large",
                },
            ],
        },
    ];
}

function modeConfigOptions(mode: string): readonly SessionConfigOption[] {
    return [
        {
            booleanValue: false,
            category: "mode",
            currentValue: mode,
            description: "Agent session mode",
            id: "mode",
            name: "Mode",
            type: "select",
            values: [
                {
                    description: "Answer and act directly",
                    groupId: "modes",
                    groupName: "Modes",
                    name: "Ask",
                    value: "ask",
                },
                {
                    description: "Plan before acting",
                    groupId: "modes",
                    groupName: "Modes",
                    name: "Plan",
                    value: "plan",
                },
            ],
        },
    ];
}

describe.sequential("Session persistence boundaries", () => {
    it("Given a Session contains more recorded events than the browser stream buffer, When the user starts another Agent turn, Then the complete response appears without an event-stream recovery failure", async ({
        signal,
    }) => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const initialPreparation = decodeSessionPrepareCommand(
                await paired.daemon.receive(SESSION_PREPARE_KIND, signal),
            );
            await sendReadySession(paired.daemon, initialPreparation);
            await closeMobiusTransport();
            cleanup();

            // Cross the 256-event stream capacity with the smallest overflowing backlog. The production Runtime
            // serializes one Session lane, so bounded groups keep it busy without starting every acknowledgement
            // deadline at once.
            const recordedEventCount = 257;
            const batchSize = 32;
            for (let offset = 0; offset < recordedEventCount; offset += batchSize) {
                const count = Math.min(batchSize, recordedEventCount - offset);
                await Promise.all(
                    Array.from({ length: count }, async (_entry, index) => {
                        const eventIndex = offset + index;
                        await paired.daemon.sendSessionEvent(
                            initialPreparation.sessionId,
                            encodeSessionInfoUpdatedEvent({
                                kind: "session.info.updated",
                                sessionId: initialPreparation.sessionId,
                                title: `Recorded backlog ${eventIndex.toString()}`,
                                updatedAt: new Date(Date.UTC(2026, 8, 8, 0, 0, 0, eventIndex)).toISOString(),
                            }),
                            signal,
                        );
                    }),
                );
            }

            signal.throwIfAborted();
            render(<App />);
            const resumedPreparation = decodeSessionPrepareCommand(
                await paired.daemon.receive(SESSION_PREPARE_KIND, signal),
            );
            await sendReadySession(paired.daemon, resumedPreparation);
            await completeRenderedPrompt(
                paired.daemon,
                "Continue after replaying recorded history",
                "The complete response survived the recorded event backlog.",
            );

            expect(screen.queryByText(/The Mobius event stream could not recover/u)).toBeNull();
            expect(screen.queryByText(/Agent response failed/u)).toBeNull();
        } finally {
            cleanup();
            paired.daemon.close();
            await closeMobiusTransport();
        }
    }, 45_000);

    it("Given Cloudflare resets the Runtime while Agent settings are loading, When the daemon and browser reconnect, Then the interrupted preparation resumes without a permanent connection error", async ({
        signal,
    }) => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);
        let reconnectedDaemon = paired.daemon;

        try {
            await paired.daemon.receive(SESSION_PREPARE_KIND);
            vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
            vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
            await environment.evictRuntime(paired.channelId);
            await paired.daemon.waitForClose(signal);
            await vi.advanceTimersByTimeAsync(0);
            await waitForDocumentState(() => screen.queryByRole("status", { name: "Reconnecting" }) !== null, signal);
            expect(screen.getByRole("status", { name: "Reconnecting" })).toBeDefined();
            expect(screen.queryByRole("status", { name: "Runtime offline" })).toBeNull();
            reconnectedDaemon = await paired.reconnectDaemon();
            await vi.advanceTimersByTimeAsync(10_000);
            vi.useRealTimers();

            const prepare = decodeSessionPrepareCommand(await reconnectedDaemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(reconnectedDaemon, prepare);

            const promptInput = await screen.findByRole("textbox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });
            expect(screen.queryByText(/connection_closed/u)).toBeNull();
        } finally {
            vi.useRealTimers();
            cleanup();
            paired.daemon.close();
            reconnectedDaemon.close();
            await closeMobiusTransport();
        }
    }, 45_000);

    it("Given the built-in Web application has an attachment, When a user submits the core chat workflow, Then it uses the public artifact and Turn API instead of placing content in the channel control message", async ({
        signal,
    }) => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, preparation);
            useChatStore.getState().addDraftResource({
                mimeType: "text/plain",
                name: "public-api-context.txt",
                text: "content transferred outside the control message",
                type: "embedded",
                uri: "attachment:///public-api-context.txt",
            });
            await screen.findByText("public-api-context.txt");
            const promptInput = screen.getByRole("textbox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });
            fireEvent.change(promptInput, {
                target: { value: "Use the public attachment" },
            });
            const sendButton = screen.getByRole("button", { name: "Send message" });
            await new Promise<void>((resolve, reject) => {
                signal.throwIfAborted();
                const cleanup = () => {
                    observer.disconnect();
                    signal.removeEventListener("abort", aborted);
                };
                const ready = () => {
                    if (!sendButton.hasAttribute("disabled")) {
                        cleanup();
                        resolve();
                    }
                };
                const aborted = () => {
                    cleanup();
                    reject(signal.reason);
                };
                const observer = new MutationObserver(ready);
                observer.observe(sendButton, { attributes: true, attributeFilter: ["disabled"] });
                signal.addEventListener("abort", aborted, { once: true });
                ready();
            });
            fireEvent.click(sendButton);

            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(prompt.resources).toHaveLength(1);
            expect(prompt.resources[0]).toMatchObject({
                mimeType: "text/plain",
                name: "public-api-context.txt",
                text: "",
                type: "link",
            });
            expect(prompt.resources[0]?.uri).toMatch(/^mobius-artifact:/);
            expect(JSON.stringify(prompt)).not.toContain("content transferred outside the control message");
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "public-sdk-attempt",
                    commandId: prompt.commandId,
                    kind: "session.started",
                    sessionId: prompt.sessionId,
                }),
            );
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionCompletedEvent({
                    commandId: prompt.commandId,
                    kind: "session.completed",
                    sessionId: prompt.sessionId,
                    stopReason: "end_turn",
                }),
            );
        } finally {
            await closeMobiusTransport();
            cleanup();
            paired.daemon.close();
        }
    });

    it("Given a user selected a workspace, Agent, and run configuration, When they start a new chat, Then the new Session reuses all three selections", async () => {
        const paired = await pairDaemon({
            agents: [
                {
                    agentPath: "/usr/local/bin/codex",
                    agentVersion: "codex 0.153.0",
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
                {
                    agentPath: "/usr/local/bin/claude",
                    agentVersion: "claude 2.1.210",
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
                    id: "claude",
                    label: "Claude",
                },
            ],
        });
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const initialPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, initialPreparation);

            fireEvent.click(await screen.findByRole("button", { name: /Workspace directory:/ }));
            const homeRequest = decodeWorkspaceListCommand(await paired.daemon.receive(WORKSPACE_LIST_KIND));
            paired.daemon.send(
                encodeWorkspaceEntriesEvent({
                    bindingId: homeRequest.bindingId,
                    directoryId: homeRequest.directoryId,
                    directoryLabel: "/projects",
                    entries: [{ directoryId: "selected-project", name: "Selected project" }],
                    kind: "workspace.entries",
                    parentDirectoryId: "",
                    requestId: homeRequest.requestId,
                }),
            );
            const workspacePicker = await screen.findByRole("dialog", {
                name: "Choose workspace",
            });
            fireEvent.click(
                await within(workspacePicker).findByRole("button", {
                    name: "Selected project",
                }),
            );
            const selectedDirectoryRequest = decodeWorkspaceListCommand(
                await paired.daemon.receive(WORKSPACE_LIST_KIND),
            );
            expect(selectedDirectoryRequest.directoryId).toBe("selected-project");
            paired.daemon.send(
                encodeWorkspaceEntriesEvent({
                    bindingId: selectedDirectoryRequest.bindingId,
                    directoryId: selectedDirectoryRequest.directoryId,
                    directoryLabel: "/projects/selected",
                    entries: [],
                    kind: "workspace.entries",
                    parentDirectoryId: homeRequest.directoryId,
                    requestId: selectedDirectoryRequest.requestId,
                }),
            );
            fireEvent.click(
                await within(workspacePicker).findByRole("button", {
                    name: "Use this folder",
                }),
            );
            const directoryPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(directoryPreparation).toMatchObject({
                agentId: "codex",
                directoryId: "selected-project",
            });
            await sendReadySession(paired.daemon, directoryPreparation);

            const agentPicker = screen.getByRole("button", {
                name: "Agent or Bot for this conversation",
            });
            fireEvent.click(agentPicker);
            fireEvent.click(
                within(screen.getByRole("tabpanel", { name: "Local Agents" })).getByRole("button", {
                    name: "Claude",
                }),
            );
            const selectedAgentPreparation = decodeSessionPrepareCommand(
                await paired.daemon.receive(SESSION_PREPARE_KIND),
            );
            expect(selectedAgentPreparation).toMatchObject({
                agentId: "claude",
                directoryId: "selected-project",
            });
            await sendReadySession(paired.daemon, selectedAgentPreparation, modeConfigOptions("ask"));

            fireEvent.click(await screen.findByRole("button", { name: /Run settings: Ask/ }));
            const modePicker = screen.getByRole("combobox", { name: "Mode" });
            fireEvent.pointerDown(modePicker, {
                button: 0,
                pointerType: "mouse",
            });
            fireEvent.click(await screen.findByRole("option", { name: "Plan" }));
            const selectedConfiguration = decodeSessionConfigureCommand(
                await paired.daemon.receive(SESSION_CONFIGURE_KIND),
            );
            expect(selectedConfiguration).toMatchObject({
                agentId: "claude",
                configId: "mode",
                sessionId: selectedAgentPreparation.sessionId,
                value: "plan",
            });
            await paired.daemon.sendSessionEvent(
                selectedAgentPreparation.sessionId,
                encodeSessionConfigUpdatedEvent({
                    configOptions: modeConfigOptions("plan"),
                    kind: "session.config.updated",
                    requestId: selectedConfiguration.requestId,
                    sessionId: selectedAgentPreparation.sessionId,
                }),
            );
            await completeRenderedPrompt(paired.daemon, "Remember my chat setup", "SETUP-REMEMBERED");

            fireEvent.click(
                within(
                    screen.getByRole("complementary", {
                        name: "Conversation sidebar",
                    }),
                ).getByRole("button", { name: /New chat.*⌘ N/ }),
            );

            const nextPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(nextPreparation).toMatchObject({
                agentId: "claude",
                directoryId: "selected-project",
            });
            await sendReadySession(paired.daemon, nextPreparation, modeConfigOptions("ask"));
            const restoredConfiguration = decodeSessionConfigureCommand(
                await paired.daemon.receive(SESSION_CONFIGURE_KIND),
            );
            expect(restoredConfiguration).toMatchObject({
                agentId: "claude",
                configId: "mode",
                sessionId: nextPreparation.sessionId,
                value: "plan",
            });
            await paired.daemon.sendSessionEvent(
                nextPreparation.sessionId,
                encodeSessionConfigUpdatedEvent({
                    configOptions: modeConfigOptions("plan"),
                    kind: "session.config.updated",
                    requestId: restoredConfiguration.requestId,
                    sessionId: nextPreparation.sessionId,
                }),
            );
            expect(
                screen.getByRole("button", {
                    name: "Agent or Bot for this conversation",
                }).textContent,
            ).toContain("Claude");
            await screen.findByRole("button", { name: /Run settings: Plan/ });
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an Agent previously used a selected model configuration, When a user starts another conversation with that Agent, Then the new Session restores that configuration by default", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const initialPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, initialPreparation, modelConfigOptions("test-small"));

            fireEvent.click(
                await screen.findByRole("button", {
                    name: /Run settings: Test Small/,
                }),
            );
            const modelPicker = screen.getByRole("combobox", { name: "Model" });
            fireEvent.pointerDown(modelPicker, {
                button: 0,
                pointerType: "mouse",
            });
            fireEvent.click(await screen.findByRole("option", { name: "Test Large" }));

            const selectedConfiguration = decodeSessionConfigureCommand(
                await paired.daemon.receive(SESSION_CONFIGURE_KIND),
            );
            expect(selectedConfiguration).toMatchObject({
                agentId: "codex",
                configId: "model",
                sessionId: initialPreparation.sessionId,
                value: "test-large",
            });
            await paired.daemon.sendSessionEvent(
                initialPreparation.sessionId,
                encodeSessionConfigUpdatedEvent({
                    configOptions: modelConfigOptions("test-large"),
                    kind: "session.config.updated",
                    requestId: selectedConfiguration.requestId,
                    sessionId: initialPreparation.sessionId,
                }),
            );
            await screen.findByRole("button", {
                name: /Run settings: Test Large/,
            });

            await completeRenderedPrompt(paired.daemon, "Remember this model", "MODEL-REMEMBERED");
            fireEvent.click(
                within(
                    screen.getByRole("complementary", {
                        name: "Conversation sidebar",
                    }),
                ).getByRole("button", { name: /New chat.*⌘ N/ }),
            );

            const nextPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, nextPreparation, modelConfigOptions("test-small"));
            const restoredConfiguration = decodeSessionConfigureCommand(
                await paired.daemon.receive(SESSION_CONFIGURE_KIND),
            );
            expect(restoredConfiguration).toMatchObject({
                agentId: "codex",
                configId: "model",
                sessionId: nextPreparation.sessionId,
                value: "test-large",
            });
            expect(screen.getByRole("textbox", { name: "Message the local agent" }).getAttribute("placeholder")).toBe(
                "Loading agent settings",
            );
            await paired.daemon.sendSessionEvent(
                nextPreparation.sessionId,
                encodeSessionConfigUpdatedEvent({
                    configOptions: modelConfigOptions("test-large"),
                    kind: "session.config.updated",
                    requestId: restoredConfiguration.requestId,
                    sessionId: nextPreparation.sessionId,
                }),
            );

            await screen.findByRole("button", {
                name: /Run settings: Test Large/,
            });
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an additional workspace is selected before the first prompt, When background history refreshes before preparation completes, Then the local identity remains ready to use", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const initialPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, initialPreparation);

            fireEvent.click(await screen.findByRole("button", { name: /Workspace directory:/ }));
            const workspaceRequest = decodeWorkspaceListCommand(await paired.daemon.receive(WORKSPACE_LIST_KIND));
            paired.daemon.send(
                encodeWorkspaceEntriesEvent({
                    bindingId: workspaceRequest.bindingId,
                    directoryId: workspaceRequest.directoryId,
                    directoryLabel: "/workspace",
                    entries: [
                        {
                            directoryId: "shared-policy-workspace",
                            name: "Shared policy workspace",
                        },
                    ],
                    kind: "workspace.entries",
                    parentDirectoryId: "",
                    requestId: workspaceRequest.requestId,
                }),
            );
            const picker = await screen.findByRole("dialog", {
                name: "Choose workspace",
            });
            fireEvent.click(
                await within(picker).findByRole("button", {
                    name: "Add Shared policy workspace as an additional directory",
                }),
            );
            const selectedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(selectedPreparation.additionalDirectoryIds).toEqual(["shared-policy-workspace"]);
            fireEvent.click(
                within(picker).getByRole("button", {
                    name: "Close directory browser",
                }),
            );

            useChatStore.getState().reconcileHistory(await readChannelHistory(paired.channelId));

            expect(
                screen.getByRole("button", {
                    name: "Remove Shared policy workspace",
                }),
            ).toBeTruthy();
            await sendReadySession(paired.daemon, selectedPreparation);
            await screen.findByRole("button", { name: /Run settings:/ });
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a prompted Session uses an additional workspace, When the Web app reloads, Then preparation retains the immutable workspace identity", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const initialPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, initialPreparation);

            fireEvent.click(await screen.findByRole("button", { name: /Workspace directory:/ }));
            const workspaceRequest = decodeWorkspaceListCommand(await paired.daemon.receive(WORKSPACE_LIST_KIND));
            paired.daemon.send(
                encodeWorkspaceEntriesEvent({
                    bindingId: workspaceRequest.bindingId,
                    directoryId: workspaceRequest.directoryId,
                    directoryLabel: "/workspace",
                    entries: [
                        {
                            directoryId: "shared-policy-workspace",
                            name: "Shared policy workspace",
                        },
                    ],
                    kind: "workspace.entries",
                    parentDirectoryId: "",
                    requestId: workspaceRequest.requestId,
                }),
            );
            const picker = await screen.findByRole("dialog", {
                name: "Choose workspace",
            });
            fireEvent.click(
                await within(picker).findByRole("button", {
                    name: "Add Shared policy workspace as an additional directory",
                }),
            );
            const selectedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(selectedPreparation.additionalDirectoryIds).toEqual(["shared-policy-workspace"]);
            await sendReadySession(paired.daemon, selectedPreparation);
            fireEvent.click(
                within(picker).getByRole("button", {
                    name: "Close directory browser",
                }),
            );
            await completeRenderedPrompt(paired.daemon, "Use the shared policy workspace", "SHARED-POLICY-USED");

            cleanup();
            await closeMobiusTransport();
            render(<App />);
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(resumedPreparation).toMatchObject({
                additionalDirectoryIds: ["shared-policy-workspace"],
                sessionId: selectedPreparation.sessionId,
            });
            await sendReadySession(paired.daemon, resumedPreparation);
            await screen.findByRole("button", { name: /Run settings:/ });
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given several persisted Sessions, When a user selects an older Session and reloads, Then its route and selection are restored", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const olderPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, olderPreparation);
            await completeRenderedPrompt(paired.daemon, "Older persisted prompt", "OLDER-RESPONSE");

            fireEvent.click(
                within(
                    screen.getByRole("complementary", {
                        name: "Conversation sidebar",
                    }),
                ).getByRole("button", { name: /New chat.*⌘ N/ }),
            );
            const newerPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, newerPreparation);
            await completeRenderedPrompt(paired.daemon, "Newest persisted prompt", "NEWEST-RESPONSE");
            expect(window.location.pathname).toBe(
                `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(newerPreparation.sessionId)}`,
            );

            const conversations = await screen.findByRole("navigation", {
                name: "Conversations",
            });
            const conversationLinks = within(conversations).getAllByRole("link");
            expect(conversationLinks).toHaveLength(2);
            expect(conversationLinks[0]?.textContent).toContain("Newest persisted prompt");
            expect(conversationLinks[1]?.textContent).toContain("Older persisted prompt");
            fireEvent.click(
                within(conversations).getByRole("link", {
                    name: /Older persisted prompt/,
                }),
            );
            await screen.findByRole("heading", {
                level: 1,
                name: "Older persisted prompt",
            });
            expect(window.location.pathname).toBe(
                `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(olderPreparation.sessionId)}`,
            );

            cleanup();
            await closeMobiusTransport();
            render(<App />);
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(resumedPreparation.sessionId).toBe(olderPreparation.sessionId);
            await sendReadySession(paired.daemon, resumedPreparation);

            const restoredConversations = await screen.findByRole("navigation", {
                name: "Conversations",
            });
            await waitFor(() => {
                const conversationButtons = within(restoredConversations).getAllByRole("link");
                expect(conversationButtons).toHaveLength(2);
                expect(conversationButtons[0]?.textContent).toContain("Newest persisted prompt");
                expect(conversationButtons[1]?.textContent).toContain("Older persisted prompt");
            });
            expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Older persisted prompt");
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a titled Session has no Turns, When the Web app reloads, Then the same Session remains visible and resumes preparation", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const initialPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, initialPreparation);
            await paired.daemon.sendSessionEvent(
                initialPreparation.sessionId,
                encodeSessionInfoUpdatedEvent({
                    kind: "session.info.updated",
                    sessionId: initialPreparation.sessionId,
                    title: "Prepared empty Session",
                    updatedAt: "2026-09-06T12:00:00.000Z",
                }),
            );
            await screen.findByRole("heading", {
                level: 1,
                name: "Prepared empty Session",
            });

            cleanup();
            await closeMobiusTransport();
            render(<App />);
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(resumedPreparation.sessionId).toBe(initialPreparation.sessionId);
            await sendReadySession(paired.daemon, resumedPreparation);

            const conversations = await screen.findByRole("navigation", {
                name: "Conversations",
            });
            expect(
                within(conversations).getByRole("link", {
                    name: /Prepared empty Session/,
                }),
            ).toBeTruthy();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a prepared Session changes configuration, When the next Turn is sent and the page reloads, Then both use the new immutable binding", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const initialPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, initialPreparation);
            await paired.daemon.sendSessionEvent(
                initialPreparation.sessionId,
                encodeSessionConfigUpdatedEvent({
                    configOptions: [
                        {
                            booleanValue: false,
                            category: "model",
                            currentValue: "configured",
                            description: "Execution model",
                            id: "model",
                            name: "Model",
                            type: "select",
                            values: [
                                {
                                    description: "Configured model",
                                    groupId: "models",
                                    groupName: "Models",
                                    name: "Configured",
                                    value: "configured",
                                },
                            ],
                        },
                    ],
                    kind: "session.config.updated",
                    requestId: "configuration-binding",
                    sessionId: initialPreparation.sessionId,
                }),
            );
            await screen.findByRole("button", {
                name: /Run settings: Configured/,
            });

            const promptInput = screen.getByRole("textbox", {
                name: "Message the local agent",
            });
            fireEvent.change(promptInput, {
                target: { value: "Use the configured binding" },
            });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(prompt.bindingId).toBe("configuration-binding");
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "configured-attempt",
                    commandId: prompt.commandId,
                    kind: "session.started",
                    sessionId: prompt.sessionId,
                }),
            );
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionCompletedEvent({
                    commandId: prompt.commandId,
                    kind: "session.completed",
                    sessionId: prompt.sessionId,
                    stopReason: "end_turn",
                }),
            );

            cleanup();
            await closeMobiusTransport();
            render(<App />);
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(resumedPreparation).toMatchObject({
                bindingId: "configuration-binding",
                sessionId: initialPreparation.sessionId,
            });
            await sendReadySession(paired.daemon, resumedPreparation);
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });
});
