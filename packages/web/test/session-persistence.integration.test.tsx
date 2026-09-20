import {
    decodeSessionCancelCommand,
    decodeSessionConfigureCommand,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    decodeWorkspaceListCommand,
    encodeSessionCompletedEvent,
    encodeSessionConfigUpdatedEvent,
    encodeSessionInfoUpdatedEvent,
    encodeSessionStartedEvent,
    encodeWorkspaceEntriesEvent,
    SESSION_CANCEL_KIND,
    SESSION_CONFIGURE_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    type SessionConfigOption,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { dataTestId } from "@/data-testid";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { readChannelConnection, readConnectionHistory } from "@/services/pairing-api";
import {
    completeRenderedPrompt,
    createTestApplication,
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
        createTestApplication();

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
            createTestApplication();
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
        createTestApplication();
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

            const promptInput = await screen.findByRole("combobox", {
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
        createTestApplication();

        try {
            const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, preparation);
            const attachFiles = screen.getByTestId(dataTestId.attachPromptFiles);
            await waitFor(() => expect(attachFiles.hasAttribute("disabled")).toBe(false));
            fireEvent.click(attachFiles);
            const fileInput = screen.getByTestId(dataTestId.promptFileInput);
            if (!(fileInput instanceof HTMLInputElement)) {
                throw new Error("The attachment picker is unavailable");
            }
            fireEvent.change(fileInput, {
                target: {
                    files: [
                        new File(["content transferred outside the control message"], "public-api-context.txt", {
                            type: "text/plain",
                        }),
                    ],
                },
            });
            expect((await screen.findByTestId(dataTestId.promptAttachment)).textContent).toContain(
                "public-api-context.txt",
            );
            const promptInput = screen.getByRole("combobox", {
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

    it("Given the Agent accepts image prompts, When a user pastes an image into the composer, Then it is attached and uploaded as an artifact rather than inlined into the control message", async ({
        signal,
    }) => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();

        try {
            const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, preparation);
            const promptInput = await screen.findByRole("combobox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });

            // A byte pattern that is stable and recognizable, so a leak into the control message is detectable.
            const pastedBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
            const clipboard = new DataTransfer();
            clipboard.items.add(new File([pastedBytes], "", { type: "image/png" }));
            fireEvent.paste(promptInput, { clipboardData: clipboard });

            const chips = await screen.findByRole("list", { name: "Prompt images" });
            expect(within(chips).getByText("pasted-image.png")).toBeDefined();

            fireEvent.change(promptInput, { target: { value: "Describe the pasted image" } });
            await waitFor(() => {
                expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(false);
            });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));

            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND, signal));
            expect(prompt.resources).toHaveLength(1);
            expect(prompt.resources[0]).toMatchObject({
                mimeType: "image/png",
                name: "pasted-image.png",
                text: "",
                type: "link",
            });
            expect(prompt.resources[0]?.uri).toMatch(/^mobius-artifact:/);
            // The bytes travel as an artifact upload; only the reference may appear in the control message.
            expect(JSON.stringify(prompt)).not.toContain(btoa(String.fromCharCode(...pastedBytes)));

            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "pasted-image-attempt",
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

    it("Given a browser only exposes a pasted image through clipboard items, When the user pastes it, Then it is still attached", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();

        try {
            const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, preparation);
            const promptInput = await screen.findByRole("combobox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });

            const clipboard = new DataTransfer();
            clipboard.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
            // Simulate the browsers that leave `files` empty for image payloads.
            fireEvent.paste(promptInput, { clipboardData: { files: [], items: clipboard.items } });

            const chips = await screen.findByRole("list", { name: "Prompt images" });
            expect(within(chips).getByText("shot.png")).toBeDefined();
        } finally {
            await closeMobiusTransport();
            cleanup();
            paired.daemon.close();
        }
    });

    it("Given a user sent an image attachment, When the Web app reloads, Then the image is restored from its artifact instead of degrading to a filename", async ({
        signal,
    }) => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();

        try {
            const initialPreparation = decodeSessionPrepareCommand(
                await paired.daemon.receive(SESSION_PREPARE_KIND, signal),
            );
            await sendReadySession(paired.daemon, initialPreparation);
            const promptInput = await screen.findByRole("combobox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });

            const clipboard = new DataTransfer();
            clipboard.items.add(new File([new Uint8Array([137, 80, 78, 71])], "", { type: "image/png" }));
            fireEvent.paste(promptInput, { clipboardData: clipboard });
            await screen.findByRole("list", { name: "Prompt images" });

            const prompt = await completeRenderedPrompt(paired.daemon, "Keep this image", "IMAGE-KEPT");

            // Reload: the Turn is now re-hydrated from the Relay, whose recorded image carries no inline data.
            cleanup();
            await closeMobiusTransport();
            createTestApplication();
            const resumedPreparation = decodeSessionPrepareCommand(
                await paired.daemon.receive(SESSION_PREPARE_KIND, signal),
            );
            await sendReadySession(paired.daemon, resumedPreparation);

            const history = await readConnectionHistory(await readChannelConnection(paired.channelId));
            const recorded = history.turns.find((turn) => turn.commandId === prompt.commandId);
            expect(recorded?.resources[0]?.uri).toMatch(/^mobius-artifact:/);

            const restored = await screen.findByRole("img", { name: "pasted-image.png" });
            expect(restored.getAttribute("src")).toMatch(/^blob:/);
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
        createTestApplication();

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
                name: "Agent for this conversation",
            });
            fireEvent.click(agentPicker);
            fireEvent.click(
                within(screen.getByRole("dialog", { name: "Choose local Agent" })).getByRole("button", {
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
                    name: "Agent for this conversation",
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
        createTestApplication();

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
            expect(screen.getByRole("combobox", { name: "Message the local agent" }).getAttribute("placeholder")).toBe(
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

    it("Given a prompted Session uses an additional workspace, When the Web app reloads, Then preparation retains the immutable workspace identity", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();

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
            createTestApplication();
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
        createTestApplication();

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
            // Both Sessions are present. Their relative order is owned by the dedicated activity-ordering
            // scenario: the Relay stamps `updated_at` from its own clock, and these two Turns complete
            // close enough together that the order is not something this test can pin down.
            expect(conversationLinks.map((link) => link.textContent)).toEqual(
                expect.arrayContaining([
                    expect.stringContaining("Newest persisted prompt"),
                    expect.stringContaining("Older persisted prompt"),
                ]),
            );
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
            createTestApplication();
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(resumedPreparation.sessionId).toBe(olderPreparation.sessionId);
            await sendReadySession(paired.daemon, resumedPreparation);

            const restoredConversations = await screen.findByRole("navigation", {
                name: "Conversations",
            });
            await waitFor(() => {
                const conversationButtons = within(restoredConversations).getAllByRole("link");
                expect(conversationButtons).toHaveLength(2);
                // This scenario is about the restored route and selection, not about the relative order of
                // two Sessions whose Turns completed milliseconds apart — the Relay stamps `updated_at`
                // itself, so that order is not something this test can pin down.
                expect(conversationButtons.map((button) => button.textContent)).toEqual(
                    expect.arrayContaining([
                        expect.stringContaining("Newest persisted prompt"),
                        expect.stringContaining("Older persisted prompt"),
                    ]),
                );
            });
            expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Older persisted prompt");
            const restoredConversationButtons = within(restoredConversations).getAllByRole("link");
            expect(restoredConversationButtons[0]?.textContent).not.toContain("default");
            expect(restoredConversationButtons[0]?.textContent).toContain("Default workspace");
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given three Sessions with different activity times, When the Web app reloads, Then the list orders them by most recent activity", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();

        try {
            const sessions: string[] = [];
            for (const title of ["Oldest activity", "Middle activity"]) {
                if (sessions.length > 0) {
                    fireEvent.click(
                        within(screen.getByRole("complementary", { name: "Conversation sidebar" })).getByRole(
                            "button",
                            { name: /New chat.*⌘ N/ },
                        ),
                    );
                }
                const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
                await sendReadySession(paired.daemon, preparation);
                await completeRenderedPrompt(paired.daemon, title, `${title.toUpperCase()}-RESPONSE`);
                sessions.push(preparation.sessionId);
            }

            // A fresh Session becomes the most recently active one.
            fireEvent.click(
                within(screen.getByRole("complementary", { name: "Conversation sidebar" })).getByRole("button", {
                    name: /New chat.*⌘ N/,
                }),
            );
            const newestPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, newestPreparation);

            cleanup();
            await closeMobiusTransport();
            createTestApplication();
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, resumedPreparation);

            // Every restored row carries the Relay's activity time, so the order must not fall back to
            // whatever order the store happened to hold.
            const conversations = await screen.findByRole("navigation", { name: "Conversations" });
            await waitFor(() => {
                const links = within(conversations).getAllByRole("link");
                expect(links).toHaveLength(3);
                // The two persisted Sessions order by the Relay's activity time; the unsent draft has no
                // activity of its own, so it trails them.
                expect(links[0]?.textContent).toContain("Middle activity");
                expect(links[1]?.textContent).toContain("Oldest activity");
                expect(links[2]?.textContent).toContain("New chat");
            });
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
        createTestApplication();

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
            createTestApplication();
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

    it("Given a user typed an unsent prompt, When the Web app reloads, Then the composer still holds that text", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();

        try {
            const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, preparation);

            const draft = "line1\nline2\n  indented\n\nDRAFT-LOSS-VERIFY";
            const promptInput = await screen.findByRole("combobox", { name: "Message the local agent" });
            fireEvent.change(promptInput, { target: { value: draft } });
            expect((promptInput as HTMLTextAreaElement).value).toBe(draft);

            // A reload discards every in-memory conversation, so the text has to come back from storage.
            cleanup();
            await closeMobiusTransport();
            createTestApplication();
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, resumedPreparation);

            const restoredInput = await screen.findByRole("combobox", { name: "Message the local agent" });
            await waitFor(() => {
                expect((restoredInput as HTMLTextAreaElement).value).toBe(draft);
            });

            // Sending the prompt consumes the draft, so it must not come back on the next reload.
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(prompt.prompt).toBe(draft);
            cleanup();
            await closeMobiusTransport();
            createTestApplication();
            const finalPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, finalPreparation);
            const consumedInput = await screen.findByRole("combobox", { name: "Message the local agent" });
            await waitFor(() => {
                expect((consumedInput as HTMLTextAreaElement).value).toBe("");
            });
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
        createTestApplication();

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

            const promptInput = screen.getByRole("combobox", {
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
            createTestApplication();
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

    it("Given a Turn is still working when the Web app reloads, When the user stops it, Then the Agent receives the cancellation instead of an unavailable-Turn error", async ({
        signal,
    }) => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();

        try {
            const initialPreparation = decodeSessionPrepareCommand(
                await paired.daemon.receive(SESSION_PREPARE_KIND, signal),
            );
            await sendReadySession(paired.daemon, initialPreparation);

            const promptInput = await screen.findByRole("combobox", { name: "Message the local agent" });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });
            fireEvent.change(promptInput, { target: { value: "Run a long tool call" } });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND, signal));
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "long-running-attempt",
                    commandId: prompt.commandId,
                    kind: "session.started",
                    sessionId: prompt.sessionId,
                }),
                signal,
            );

            // The Turn stays running: reload while the Agent is still working on it.
            cleanup();
            await closeMobiusTransport();
            createTestApplication();
            const resumedPreparation = decodeSessionPrepareCommand(
                await paired.daemon.receive(SESSION_PREPARE_KIND, signal),
            );
            await sendReadySession(paired.daemon, resumedPreparation);

            const stopButton = await screen.findByRole("button", { name: "Stop agent" });
            fireEvent.click(stopButton);

            const cancelled = decodeSessionCancelCommand(await paired.daemon.receive(SESSION_CANCEL_KIND, signal));
            expect(cancelled.commandId).toBe(prompt.commandId);
            expect(screen.queryByRole("alert")).toBeNull();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a Session is running, When the Web app reloads on a different Session, Then the running one is still marked as running", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        createTestApplication();

        try {
            // Start a Turn and leave it running in this Session.
            const runningPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, runningPreparation);

            const promptInput = await screen.findByRole("combobox", { name: "Message the local agent" });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });
            fireEvent.change(promptInput, { target: { value: "Run a long tool call" } });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "still-running-attempt",
                    commandId: prompt.commandId,
                    kind: "session.started",
                    sessionId: prompt.sessionId,
                }),
            );
            expect(await screen.findByRole("button", { name: "Stop agent" })).toBeTruthy();

            // A second Session for the reload to land on, so the running Turn is not the active one.
            fireEvent.click(
                within(screen.getByRole("complementary", { name: "Conversation sidebar" })).getByRole("button", {
                    name: /New chat.*⌘ N/,
                }),
            );
            const otherPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(otherPreparation.sessionId).not.toBe(runningPreparation.sessionId);
            await sendReadySession(paired.daemon, otherPreparation);

            // Reload onto the other Session. The Session summary carries no running signal, so the running
            // Session stays marked only if the refresh hydrates every Session rather than the active one.
            cleanup();
            await closeMobiusTransport();
            const otherSessionPath = `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(otherPreparation.sessionId)}`;
            window.history.replaceState(null, "", otherSessionPath);
            createTestApplication();
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(resumedPreparation.sessionId).toBe(otherPreparation.sessionId);
            await sendReadySession(paired.daemon, resumedPreparation);

            const running = await waitFor(() => {
                const section = document.querySelector('section[aria-labelledby="running-conversations-heading"]');
                if (section === null) {
                    throw new Error("The running section is missing");
                }
                return section as HTMLElement;
            });
            expect(within(running).getByRole("link").textContent).toContain("Run a long tool call");
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });
});
