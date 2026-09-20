import {
    decodeSessionCancelCommand,
    decodeSessionConfigureCommand,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    decodeWorkspaceListCommand,
    encodeAgentActivityEvent,
    encodeAgentMessageDeltaEvent,
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
    openReadyApplication,
    pairDaemon,
    saveBrowserCredential,
    sendReadySession,
    setupWebIntegrationEnvironment,
    waitForDocumentState,
} from "./app-integration-harness.ts";

const environment = setupWebIntegrationEnvironment();

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
        const paired = await openReadyApplication();

        try {
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
            await paired.close();
        }
    });

    it("Given the Agent accepts image prompts, When a user sends and reloads a pasted image, Then its artifact remains visible without entering the control message", async ({
        signal,
    }) => {
        const paired = await openReadyApplication();

        try {
            const promptInput = await screen.findByRole("combobox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });

            // A byte pattern that is stable and recognizable, so a leak into the control message is detectable.
            const pastedBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
            const clipboard = new DataTransfer();
            clipboard.items.add(new File([pastedBytes], "shot.png", { type: "image/png" }));
            // Exercise the stricter browser shape: image payloads are available through items, but files is empty.
            fireEvent.paste(promptInput, {
                clipboardData: { files: [], items: clipboard.items },
            });

            const chips = await screen.findByRole("list", { name: "Prompt images" });
            expect(within(chips).getByText("shot.png")).toBeDefined();

            fireEvent.change(promptInput, { target: { value: "Describe the pasted image" } });
            await waitFor(() => {
                expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(false);
            });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));

            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND, signal));
            expect(prompt.resources).toHaveLength(1);
            expect(prompt.resources[0]).toMatchObject({
                mimeType: "image/png",
                name: "shot.png",
                text: "",
                type: "link",
            });
            expect(prompt.resources.every((resource) => /^mobius-artifact:/u.test(resource.uri))).toBe(true);
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
            const restored = await screen.findByRole("img", { name: "shot.png" });
            expect(restored.getAttribute("src")).toMatch(/^blob:/);
        } finally {
            await paired.close();
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
            await paired.close();
        }
    });

    it("Given a prompted Session uses an additional workspace, When the Web app reloads, Then preparation retains the immutable workspace identity", async () => {
        const paired = await openReadyApplication();

        try {
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
            await paired.close();
        }
    });

    it("Given several persisted Sessions, When a user selects an older Session and reloads, Then its route and selection are restored", async () => {
        const paired = await openReadyApplication();

        try {
            const olderPreparation = paired.preparation;
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
                expect(conversationButtons[0]?.textContent).toContain("Newest persisted prompt");
                expect(conversationButtons[1]?.textContent).toContain("Older persisted prompt");
            });
            expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Older persisted prompt");
            const restoredConversationButtons = within(restoredConversations).getAllByRole("link");
            expect(restoredConversationButtons[0]?.textContent).not.toContain("default");
            expect(restoredConversationButtons[0]?.textContent).toContain("Default workspace");
        } finally {
            await paired.close();
        }
    });

    it("Given a restored Session carries a Relay title, When the Agent reports no title, Then that title survives both the empty string and null", async () => {
        const paired = await openReadyApplication();

        try {
            const initialPreparation = paired.preparation;
            const prompt = await completeRenderedPrompt(
                paired.daemon,
                "Explain the deployment pipeline",
                "The pipeline builds and deploys.",
            );
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionInfoUpdatedEvent({
                    kind: "session.info.updated",
                    sessionId: prompt.sessionId,
                    title: "Deployment pipeline walkthrough",
                    updatedAt: "2026-09-06T12:00:00.000Z",
                }),
            );
            await waitFor(() => {
                expect(screen.getByTestId(dataTestId.conversationTitle).textContent).toBe(
                    "Deployment pipeline walkthrough",
                );
            });

            // Reload so the conversation is rebuilt from the Relay directory: its title now comes from
            // the server instead of from the first rendered prompt, and its Turns are restored.
            cleanup();
            await closeMobiusTransport();
            createTestApplication();
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(resumedPreparation.sessionId).toBe(initialPreparation.sessionId);
            await sendReadySession(paired.daemon, resumedPreparation);
            await waitFor(() => {
                expect(screen.getByTestId(dataTestId.conversationTitle).textContent).toBe(
                    "Deployment pipeline walkthrough",
                );
            });

            // An adapter without native title support reports that absence, which must not replace the
            // authoritative Relay title with one derived from the restored first prompt.
            for (const title of ["", null]) {
                await paired.daemon.sendSessionEvent(
                    prompt.sessionId,
                    encodeSessionInfoUpdatedEvent({
                        kind: "session.info.updated",
                        sessionId: prompt.sessionId,
                        title,
                        updatedAt: "2026-09-06T12:00:01.000Z",
                    }),
                );
            }

            await waitFor(() => {
                expect(screen.getAllByTestId(dataTestId.conversationTitle).map((node) => node.textContent)).toEqual([
                    "Deployment pipeline walkthrough",
                ]);
                expect(screen.getByTestId(dataTestId.conversationTitleHeader).textContent).toBe(
                    "Deployment pipeline walkthrough",
                );
            });
        } finally {
            await paired.close();
        }
    });

    it("Given a titled prepared Session has an unsent prompt, When the Web app reloads and sends it, Then the Session and draft are restored before the draft is consumed", async () => {
        const paired = await openReadyApplication();

        try {
            const preparation = paired.preparation;
            await paired.daemon.sendSessionEvent(
                preparation.sessionId,
                encodeSessionInfoUpdatedEvent({
                    kind: "session.info.updated",
                    sessionId: preparation.sessionId,
                    title: "Prepared empty Session",
                    updatedAt: "2026-09-06T12:00:00.000Z",
                }),
            );
            await screen.findByRole("heading", {
                level: 1,
                name: "Prepared empty Session",
            });

            const draft = "line1\nline2\n  indented\n\nDRAFT-LOSS-VERIFY";
            const promptInput = await screen.findByRole("combobox", { name: "Message the local agent" });
            fireEvent.change(promptInput, { target: { value: draft } });
            expect((promptInput as HTMLTextAreaElement).value).toBe(draft);

            // A reload discards every in-memory conversation, so the text has to come back from storage.
            cleanup();
            await closeMobiusTransport();
            createTestApplication();
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(resumedPreparation.sessionId).toBe(preparation.sessionId);
            await sendReadySession(paired.daemon, resumedPreparation);

            const conversations = await screen.findByRole("navigation", {
                name: "Conversations",
            });
            expect(within(conversations).getByRole("link", { name: /Prepared empty Session/ })).toBeTruthy();
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
            await paired.close();
        }
    });

    it("Given a prepared Session changes configuration, When the next Turn is sent and the page reloads, Then both use the new immutable binding", async () => {
        const paired = await openReadyApplication();

        try {
            const initialPreparation = paired.preparation;
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
            await paired.close();
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
            await paired.close();
        }
    });

    it("Given a recorded tool step exceeds the browser history limit, When the Web app reloads the Session, Then the conversation opens with the step intact", async () => {
        const paired = await openReadyApplication();

        try {
            const promptInput = await screen.findByTestId(dataTestId.promptInput);
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });
            fireEvent.change(promptInput, { target: { value: "Run the verbose installer" } });
            fireEvent.click(screen.getByTestId(dataTestId.sendPrompt));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "oversized-tool-output-attempt",
                    commandId: prompt.commandId,
                    kind: "session.started",
                    sessionId: prompt.sessionId,
                }),
            );
            // The Runtime records the visible tool output at up to the protocol's Agent activity detail
            // limit, so a step can legitimately outgrow the smaller budgets a restoring client used to
            // enforce. 150,000 characters crosses both of those older budgets.
            const oversizedOutput = `begin-${"x".repeat(150_000)}-end`;
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentActivityEvent({
                    activityId: "oversized-tool-output",
                    activityType: "tool",
                    commandId: prompt.commandId,
                    content: [],
                    detail: {
                        content: [],
                        input: "",
                        kind: "recorded",
                        output: oversizedOutput,
                    },
                    input: "",
                    kind: "agent.activity",
                    locations: [],
                    name: "terminal",
                    output: oversizedOutput,
                    sequence: 0,
                    sessionId: prompt.sessionId,
                    status: "completed",
                    title: "Run the verbose installer",
                    toolKind: "execute",
                }),
            );
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: prompt.commandId,
                    kind: "agent.message.delta",
                    messageId: `agent-${prompt.commandId}`,
                    sessionId: prompt.sessionId,
                    text: "Installer finished.",
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
            await screen.findByText("Installer finished.");

            // Restoring the Session reads the recorded history back through the relay, which is where an
            // oversized tool step used to reject the whole conversation as unavailable.
            cleanup();
            await closeMobiusTransport();
            createTestApplication();
            expect(await screen.findByText("Installer finished.")).toBeTruthy();
            expect(screen.queryByRole("heading", { name: "Session unavailable" })).toBeNull();
            const resumedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, resumedPreparation);

            const agentMessage = await screen.findByTestId(dataTestId.agentMessage);
            fireEvent.click(within(agentMessage).getByTestId(dataTestId.turnProcessSummary));
            const steps = within(agentMessage).getAllByTestId(dataTestId.agentActivity);
            expect(steps).toHaveLength(1);
            expect(steps[0]?.textContent).toContain("Run the verbose installer");
            expect((steps[0]?.textContent ?? "").length).toBeGreaterThan(150_000);
        } finally {
            await paired.close();
        }
    });
});
