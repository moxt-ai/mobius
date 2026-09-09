import {
    BOT_BINDING_APPROVAL_REQUEST_KIND,
    BOT_BINDING_APPROVED_KIND,
    BOT_SESSION_PROMPT_KIND,
    BotExecutionBindingApprovedEvent,
    decodeBotExecutionBindingApprovalRequest,
    decodeBotSessionPromptCommand,
    decodeSessionConfigureCommand,
    decodeSessionPrepareCommand,
    decodeWorkspaceListCommand,
    encodeAgentMessageDeltaEvent,
    encodeBotExecutionBindingApprovedEvent,
    encodeSessionCompletedEvent,
    encodeSessionConfigUpdatedEvent,
    encodeSessionStartedEvent,
    encodeWorkspaceEntriesEvent,
    SESSION_CONFIGURE_KIND,
    SESSION_PREPARE_KIND,
    type SessionConfigOption,
    WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import {
    createMobiusBotConnectorClient,
    redeemMobiusBotConnectionGrant,
    StaticMobiusCredentialProvider,
} from "@moxt-ai/mobius-sdk";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "@/app";
import { AgentOption } from "@/domain/channel";
import { closeMobiusTransport } from "@/services/mobius-transport";
import {
    pairDaemon,
    saveBrowserCredential,
    sendReadySession,
    setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

function definitionValue(label: string): string {
    const term = screen.getByText(label, { selector: "dt" });
    const container = term.parentElement;
    if (!(container instanceof HTMLElement)) {
        throw new Error(`Missing definition container for ${label}`);
    }
    const value = container.querySelector("dd");
    if (!(value instanceof HTMLElement) || value.textContent === null || value.textContent.trim().length === 0) {
        throw new Error(`Missing definition value for ${label}`);
    }
    return value.textContent.trim();
}

function modelConfigOptions(model: string, fastMode = false): readonly SessionConfigOption[] {
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
        {
            booleanValue: fastMode,
            category: "model_config",
            currentValue: "",
            description: "Use the lower latency execution path",
            id: "fast_mode",
            name: "Fast mode",
            type: "boolean",
            values: [],
        },
    ];
}

describe.sequential("Bot management and conversations", () => {
    it("Given every ready local Agent, When the owner confirms Bot activation in Web, Then every Agent is selectable and no second local approval is requested", async () => {
        const paired = await pairDaemon({
            agents: [
                new AgentOption("codex", "Codex", "/usr/local/bin/codex", "codex 0.153.0", {
                    additionalDirectories: true,
                    audioPrompt: false,
                    closeSession: true,
                    deleteSession: true,
                    embeddedContextPrompt: true,
                    imagePrompt: true,
                    listSessions: true,
                    loadSession: true,
                    resumeSession: true,
                    unstableForkSession: false,
                }),
                new AgentOption("cursor", "Cursor CLI", "/usr/local/bin/cursor-agent", "cursor 1.18.29", {
                    additionalDirectories: false,
                    audioPrompt: false,
                    closeSession: true,
                    deleteSession: false,
                    embeddedContextPrompt: false,
                    imagePrompt: false,
                    listSessions: true,
                    loadSession: true,
                    resumeSession: true,
                    unstableForkSession: false,
                }),
            ],
        });
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            fireEvent.click(await screen.findByRole("link", { name: "Bots" }));
            fireEvent.click(await screen.findByRole("button", { name: "Create Bot" }));
            fireEvent.change(screen.getByRole("textbox", { name: "Bot name" }), {
                target: { value: "All Agents Bot" },
            });
            fireEvent.click(screen.getByRole("button", { name: "Create Bot" }));

            await screen.findByRole("heading", { level: 1, name: "All Agents Bot" });
            const agentSelector = await screen.findByRole("combobox", { name: "Local Agent" });
            expect(
                within(agentSelector)
                    .getAllByRole("option")
                    .map((option) => option.textContent),
            ).toEqual(["Codex · codex 0.153.0", "Cursor CLI · cursor 1.18.29 · Identity only"]);
            fireEvent.change(agentSelector, { target: { value: "cursor" } });
            expect(screen.getByRole("radio", { name: /Identity only/ })).toHaveProperty("checked", true);
            expect(screen.getByRole("radio", { name: /Custom instructions/ })).toHaveProperty("disabled", true);

            fireEvent.click(screen.getByRole("button", { name: "Activate Bot" }));
            const approvalRequest = decodeBotExecutionBindingApprovalRequest(
                await paired.daemon.receive(BOT_BINDING_APPROVAL_REQUEST_KIND),
            );
            expect(approvalRequest).toMatchObject({
                agentRef: "cursor",
                behaviorInstructions: "",
                requiredCapabilities: [],
            });
            expect(await screen.findByText("Activating Bot")).toBeTruthy();
            expect(screen.queryByText("Awaiting local approval")).toBeNull();

            const approvedEvent = encodeBotExecutionBindingApprovedEvent(
                new BotExecutionBindingApprovedEvent(
                    approvalRequest.requestId,
                    approvalRequest.botId,
                    approvalRequest.behaviorRevisionId,
                    approvalRequest.bindingId,
                    approvalRequest.bindingRevision,
                    `grant_${approvalRequest.botId}`,
                    "a".repeat(64),
                    "b".repeat(64),
                ),
            );
            paired.daemon.send(approvedEvent);
            expect(await paired.daemon.receive(BOT_BINDING_APPROVED_KIND)).toBe(approvedEvent);
            await screen.findByText("Active");
            await screen.findByText("Bot activated on Integration machine.");
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an Agent without Bot instructions, When the owner activates an identity-only Bot, Then the local boundary approves an empty behavior contract", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            fireEvent.click(await screen.findByRole("link", { name: "Bots" }));
            fireEvent.click(await screen.findByRole("button", { name: "Create Bot" }));
            fireEvent.change(screen.getByRole("textbox", { name: "Bot name" }), {
                target: { value: "Identity Bot" },
            });
            fireEvent.click(screen.getByRole("button", { name: "Create Bot" }));

            await screen.findByRole("heading", { level: 1, name: "Identity Bot" });
            fireEvent.click(await screen.findByRole("radio", { name: /Identity only/ }));
            fireEvent.click(screen.getByRole("button", { name: "Activate Bot" }));

            const approvalRequest = decodeBotExecutionBindingApprovalRequest(
                await paired.daemon.receive(BOT_BINDING_APPROVAL_REQUEST_KIND),
            );
            expect(approvalRequest.behaviorInstructions).toBe("");
            expect(approvalRequest.requiredCapabilities).toEqual([]);
            const approvedEvent = encodeBotExecutionBindingApprovedEvent(
                new BotExecutionBindingApprovedEvent(
                    approvalRequest.requestId,
                    approvalRequest.botId,
                    approvalRequest.behaviorRevisionId,
                    approvalRequest.bindingId,
                    approvalRequest.bindingRevision,
                    `grant_${approvalRequest.botId}`,
                    "a".repeat(64),
                    "b".repeat(64),
                ),
            );
            paired.daemon.send(approvedEvent);
            expect(await paired.daemon.receive(BOT_BINDING_APPROVED_KIND)).toBe(approvedEvent);
            fireEvent.click(await screen.findByRole("button", { name: "Refresh Bot" }));
            await screen.findByText("Active");
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an active Bot and a new local chat, When the user switches the conversation target from Local Agents to Bots, Then Web starts a Bot conversation that can send a message", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            fireEvent.click(await screen.findByRole("link", { name: "Bots" }));
            fireEvent.click(await screen.findByRole("button", { name: "Create Bot" }));
            fireEvent.change(screen.getByRole("textbox", { name: "Bot name" }), {
                target: { value: "New chat Bot" },
            });
            fireEvent.click(screen.getByRole("button", { name: "Create Bot" }));

            await screen.findByRole("heading", { level: 1, name: "New chat Bot" });
            await screen.findByRole("combobox", { name: "Local Agent" });
            fireEvent.click(screen.getByRole("radio", { name: /Identity only/ }));
            fireEvent.click(await screen.findByRole("button", { name: "Activate Bot" }));
            const approvalRequest = decodeBotExecutionBindingApprovalRequest(
                await paired.daemon.receive(BOT_BINDING_APPROVAL_REQUEST_KIND),
            );
            const approvedEvent = encodeBotExecutionBindingApprovedEvent(
                new BotExecutionBindingApprovedEvent(
                    approvalRequest.requestId,
                    approvalRequest.botId,
                    approvalRequest.behaviorRevisionId,
                    approvalRequest.bindingId,
                    approvalRequest.bindingRevision,
                    `grant_${approvalRequest.botId}`,
                    "a".repeat(64),
                    "b".repeat(64),
                ),
            );
            paired.daemon.send(approvedEvent);
            expect(await paired.daemon.receive(BOT_BINDING_APPROVED_KIND)).toBe(approvedEvent);
            fireEvent.click(await screen.findByRole("button", { name: "Refresh Bot" }));
            await screen.findByText("Active");

            fireEvent.click(
                within(screen.getByRole("complementary", { name: "Conversation sidebar" })).getByRole("button", {
                    name: /New chat.*⌘ N/,
                }),
            );
            const localPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, localPreparation, modelConfigOptions("test-small"));
            const targetPicker = await screen.findByRole("button", {
                name: "Agent or Bot for this conversation",
            });
            fireEvent.click(targetPicker);

            const targetTabs = screen.getByRole("tablist", { name: "Conversation target type" });
            expect(within(targetTabs).getByRole("tab", { name: "Local Agents" }).getAttribute("aria-selected")).toBe(
                "true",
            );
            expect(
                within(screen.getByRole("tabpanel", { name: "Local Agents" })).getByRole("button", {
                    name: "Codex",
                }),
            ).toBeTruthy();

            fireEvent.click(within(targetTabs).getByRole("tab", { name: "Bots" }));
            const botPanel = screen.getByRole("tabpanel", { name: "Bots" });
            fireEvent.click(await within(botPanel).findByRole("button", { name: "New chat Bot, Active" }));

            await screen.findByRole("heading", { level: 2, name: "New chat" });
            expect(window.location.pathname).toBe(
                `/channels/${encodeURIComponent(paired.channelId)}/bots/${encodeURIComponent(approvalRequest.botId)}/conversations/${window.location.pathname.split("/").at(-1) ?? ""}`,
            );
            const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, preparation, modelConfigOptions("test-small"));
            const composer = screen.getByRole("textbox", { name: "Message New chat Bot" });
            fireEvent.change(composer, { target: { value: "Answer through the selected Bot." } });
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false),
            );
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));

            const prompt = decodeBotSessionPromptCommand(await paired.daemon.receive(BOT_SESSION_PROMPT_KIND));
            expect(prompt).toMatchObject({
                botId: approvalRequest.botId,
                prompt: "Answer through the selected Bot.",
            });
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an owner Bot already has an untouched New chat, When the user starts one again and sends the first prompt, Then Web reuses the draft and derives its title", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            fireEvent.click(await screen.findByRole("link", { name: "Bots" }));
            fireEvent.click(await screen.findByRole("button", { name: "Create Bot" }));
            fireEvent.change(screen.getByRole("textbox", { name: "Bot name" }), {
                target: { value: "Configured Bot" },
            });
            fireEvent.click(screen.getByRole("button", { name: "Create Bot" }));

            await screen.findByRole("heading", { level: 1, name: "Configured Bot" });
            fireEvent.click(await screen.findByRole("radio", { name: /Identity only/ }));
            fireEvent.click(screen.getByRole("button", { name: "Activate Bot" }));
            const approvalRequest = decodeBotExecutionBindingApprovalRequest(
                await paired.daemon.receive(BOT_BINDING_APPROVAL_REQUEST_KIND),
            );
            const approvedEvent = encodeBotExecutionBindingApprovedEvent(
                new BotExecutionBindingApprovedEvent(
                    approvalRequest.requestId,
                    approvalRequest.botId,
                    approvalRequest.behaviorRevisionId,
                    approvalRequest.bindingId,
                    approvalRequest.bindingRevision,
                    `grant_${approvalRequest.botId}`,
                    "a".repeat(64),
                    "b".repeat(64),
                ),
            );
            paired.daemon.send(approvedEvent);
            expect(await paired.daemon.receive(BOT_BINDING_APPROVED_KIND)).toBe(approvedEvent);
            fireEvent.click(await screen.findByRole("button", { name: "Refresh Bot" }));
            await screen.findByText("Active");

            fireEvent.click(screen.getByRole("link", { name: "Conversations" }));
            fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
            expect(screen.queryByRole("textbox", { name: "Conversation title" })).toBeNull();
            await screen.findByRole("heading", { level: 2, name: "New chat" });
            const draftPath = window.location.pathname;

            const initialPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(initialPreparation).toMatchObject({
                agentId: approvalRequest.agentRef,
                bindingId: approvalRequest.bindingId,
                directoryId: approvalRequest.workspaceRef,
            });
            await sendReadySession(paired.daemon, initialPreparation, modelConfigOptions("test-small"));

            fireEvent.click(screen.getByRole("link", { name: "Back to conversations" }));
            fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
            await waitFor(() => expect(window.location.pathname).toBe(draftPath));
            const reopenedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(reopenedPreparation.sessionId).toBe(initialPreparation.sessionId);
            await sendReadySession(paired.daemon, reopenedPreparation, modelConfigOptions("test-small"));

            const workspaceButton = await screen.findByRole("button", { name: /Workspace directory:/ });
            await waitFor(() => expect(workspaceButton.hasAttribute("disabled")).toBe(false));
            fireEvent.click(workspaceButton);
            const homeRequest = decodeWorkspaceListCommand(await paired.daemon.receive(WORKSPACE_LIST_KIND));
            paired.daemon.send(
                encodeWorkspaceEntriesEvent({
                    bindingId: homeRequest.bindingId,
                    directoryId: homeRequest.directoryId,
                    directoryLabel: "/projects",
                    entries: [{ directoryId: "selected-bot-project", name: "Selected Bot project" }],
                    kind: "workspace.entries",
                    parentDirectoryId: "",
                    requestId: homeRequest.requestId,
                }),
            );
            const workspacePicker = await screen.findByRole("dialog", { name: "Choose workspace" });
            fireEvent.click(
                await within(workspacePicker).findByRole("button", {
                    name: "Selected Bot project",
                }),
            );
            const selectedDirectoryRequest = decodeWorkspaceListCommand(
                await paired.daemon.receive(WORKSPACE_LIST_KIND),
            );
            paired.daemon.send(
                encodeWorkspaceEntriesEvent({
                    bindingId: selectedDirectoryRequest.bindingId,
                    directoryId: selectedDirectoryRequest.directoryId,
                    directoryLabel: "/projects/selected-bot",
                    entries: [],
                    kind: "workspace.entries",
                    parentDirectoryId: homeRequest.directoryId,
                    requestId: selectedDirectoryRequest.requestId,
                }),
            );
            fireEvent.click(await within(workspacePicker).findByRole("button", { name: "Use this folder" }));
            const selectedPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            expect(selectedPreparation).toMatchObject({
                agentId: approvalRequest.agentRef,
                directoryId: "selected-bot-project",
                sessionId: initialPreparation.sessionId,
            });
            await sendReadySession(paired.daemon, selectedPreparation, modelConfigOptions("test-small"));

            fireEvent.click(await screen.findByRole("button", { name: /Run settings: Test Small/ }));
            const modelPicker = screen.getByRole("combobox", { name: "Model" });
            fireEvent.pointerDown(modelPicker, { button: 0, pointerType: "mouse" });
            fireEvent.click(await screen.findByRole("option", { name: "Test Large" }));
            const configuration = decodeSessionConfigureCommand(await paired.daemon.receive(SESSION_CONFIGURE_KIND));
            expect(configuration).toMatchObject({
                configId: "model",
                directoryId: "selected-bot-project",
                sessionId: initialPreparation.sessionId,
                value: "test-large",
            });
            await paired.daemon.sendSessionEvent(
                initialPreparation.sessionId,
                encodeSessionConfigUpdatedEvent({
                    configOptions: modelConfigOptions("test-large"),
                    kind: "session.config.updated",
                    requestId: configuration.requestId,
                    sessionId: initialPreparation.sessionId,
                }),
            );
            const fastModeSwitch = await screen.findByRole("switch", { name: /Fast mode/ });
            await waitFor(() => expect(fastModeSwitch.hasAttribute("disabled")).toBe(false));
            fireEvent.click(fastModeSwitch);
            const fastModeConfiguration = decodeSessionConfigureCommand(
                await paired.daemon.receive(SESSION_CONFIGURE_KIND),
            );
            expect(fastModeConfiguration).toMatchObject({
                bindingId: configuration.requestId,
                booleanValue: true,
                configId: "fast_mode",
                directoryId: "selected-bot-project",
                sessionId: initialPreparation.sessionId,
            });
            await paired.daemon.sendSessionEvent(
                initialPreparation.sessionId,
                encodeSessionConfigUpdatedEvent({
                    configOptions: modelConfigOptions("test-large", true),
                    kind: "session.config.updated",
                    requestId: fastModeConfiguration.requestId,
                    sessionId: initialPreparation.sessionId,
                }),
            );

            const attachment = new File(["Evidence attached to the Bot prompt."], "evidence.txt", {
                type: "text/plain",
            });
            fireEvent.change(screen.getByLabelText("Choose files for Bot prompt"), {
                target: { files: [attachment] },
            });
            await screen.findByText("evidence.txt");
            fireEvent.change(screen.getByRole("textbox", { name: "Message Configured Bot" }), {
                target: { value: "Use the selected workspace, model, and evidence." },
            });
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false),
            );
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));

            const prompt = decodeBotSessionPromptCommand(await paired.daemon.receive(BOT_SESSION_PROMPT_KIND));
            expect(prompt).toMatchObject({
                directoryId: "selected-bot-project",
                prompt: "Use the selected workspace, model, and evidence.",
                sessionId: initialPreparation.sessionId,
            });
            expect(prompt.resources).toHaveLength(1);
            expect(prompt.resources[0]).toMatchObject({
                mimeType: "text/plain",
                name: "evidence.txt",
                type: "link",
            });
            expect(prompt.resources[0]?.uri.startsWith("mobius-artifact:")).toBe(true);
            await screen.findByText("Message accepted. The approved local runtime is working.");
            expect(
                screen.getByRole("heading", {
                    level: 2,
                    name: "Use the selected workspace, model, and ev…",
                }),
            ).toBeTruthy();
            fireEvent.click(screen.getByRole("link", { name: "Back to conversations" }));
            const conversations = await screen.findByRole("list", { name: "Bot conversations" });
            expect(within(conversations).getAllByRole("link")).toHaveLength(1);
            expect(within(conversations).getByRole("link", { name: /Use the selected workspace/ })).toBeTruthy();
            expect(within(conversations).queryByRole("link", { name: /New chat/ })).toBeNull();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an owned Channel with a compatible local Agent, When the user creates and activates a Bot and sends it a message, Then Web restores the durable Bot conversation and response", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            fireEvent.click(await screen.findByRole("link", { name: "Bots" }));
            await screen.findByRole("heading", { level: 1, name: "Bots" });

            fireEvent.click(await screen.findByRole("button", { name: "Create Bot" }));
            fireEvent.change(screen.getByRole("textbox", { name: "Bot name" }), {
                target: { value: "Research assistant" },
            });
            fireEvent.change(screen.getByRole("textbox", { name: "Description" }), {
                target: { value: "Answers research questions with the local Codex Agent." },
            });
            fireEvent.click(screen.getByRole("button", { name: "Create Bot" }));

            await screen.findByRole("heading", { level: 1, name: "Research assistant" });
            expect(screen.getByText("Draft")).toBeTruthy();

            fireEvent.change(await screen.findByRole("textbox", { name: "Behavior instructions" }), {
                target: { value: "Answer precisely and cite the evidence you used." },
            });
            fireEvent.click(screen.getByRole("button", { name: "Activate Bot" }));

            const approvalRequest = decodeBotExecutionBindingApprovalRequest(
                await paired.daemon.receive(BOT_BINDING_APPROVAL_REQUEST_KIND),
            );
            const approved = new BotExecutionBindingApprovedEvent(
                approvalRequest.requestId,
                approvalRequest.botId,
                approvalRequest.behaviorRevisionId,
                approvalRequest.bindingId,
                approvalRequest.bindingRevision,
                `grant_${approvalRequest.botId}`,
                "a".repeat(64),
                "b".repeat(64),
            );
            const approvedEvent = encodeBotExecutionBindingApprovedEvent(approved);
            paired.daemon.send(approvedEvent);
            expect(await paired.daemon.receive(BOT_BINDING_APPROVED_KIND)).toBe(approvedEvent);

            fireEvent.click(await screen.findByRole("button", { name: "Refresh Bot" }));
            await screen.findByText("Active");

            fireEvent.click(screen.getByRole("link", { name: "Conversations" }));
            await screen.findByRole("heading", { level: 2, name: "Conversations" });
            fireEvent.click(screen.getByRole("button", { name: "New chat" }));
            await screen.findByRole("heading", { level: 2, name: "New chat" });
            const preparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, preparation, modelConfigOptions("test-small"));
            const composer = screen.getByRole("textbox", { name: "Message Research assistant" });
            fireEvent.change(composer, { target: { value: "Summarize the launch evidence." } });
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false),
            );
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));

            const prompt = decodeBotSessionPromptCommand(await paired.daemon.receive(BOT_SESSION_PROMPT_KIND));
            expect(prompt).toMatchObject({
                botId: approvalRequest.botId,
                prompt: "Summarize the launch evidence.",
            });
            fireEvent.click(screen.getByRole("button", { name: "Refresh conversation" }));
            await waitFor(() =>
                expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true),
            );
            expect(await screen.findByRole("status", { name: "Research assistant is working" })).toBeTruthy();
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: crypto.randomUUID(),
                    commandId: prompt.commandId,
                    kind: "session.started",
                    sessionId: prompt.sessionId,
                }),
            );
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: prompt.commandId,
                    kind: "agent.message.delta",
                    sessionId: prompt.sessionId,
                    text: "The launch is supported by the persisted evidence.",
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

            fireEvent.click(screen.getByRole("button", { name: "Refresh conversation" }));
            await screen.findByText("The launch is supported by the persisted evidence.");
            await screen.findByText("Response completed.");
            expect(screen.queryByText("Message accepted. The approved local runtime is working.")).toBeNull();
            expect(screen.getByRole("heading", { level: 2, name: "Summarize the launch evidence." })).toBeTruthy();
            await waitFor(() => {
                expect(screen.getAllByLabelText("Message from you").map((message) => message.textContent)).toEqual([
                    "Summarize the launch evidence.",
                ]);
            });
            await waitFor(() => {
                expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
            });

            const followUpComposer = screen.getByRole("textbox", { name: "Message Research assistant" });
            fireEvent.change(followUpComposer, { target: { value: "List the next verification step." } });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const followUp = decodeBotSessionPromptCommand(await paired.daemon.receive(BOT_SESSION_PROMPT_KIND));
            fireEvent.click(screen.getByRole("button", { name: "Refresh conversation" }));
            expect(await screen.findByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
            await paired.daemon.sendSessionEvent(
                followUp.sessionId,
                encodeSessionStartedEvent({
                    attemptId: crypto.randomUUID(),
                    commandId: followUp.commandId,
                    kind: "session.started",
                    sessionId: followUp.sessionId,
                }),
            );
            await paired.daemon.sendSessionEvent(
                followUp.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: followUp.commandId,
                    kind: "agent.message.delta",
                    sessionId: followUp.sessionId,
                    text: "Verify the durable conversation after a full browser reload.",
                }),
            );
            await paired.daemon.sendSessionEvent(
                followUp.sessionId,
                encodeSessionCompletedEvent({
                    commandId: followUp.commandId,
                    kind: "session.completed",
                    sessionId: followUp.sessionId,
                    stopReason: "end_turn",
                }),
            );
            fireEvent.click(screen.getByRole("button", { name: "Refresh conversation" }));
            await screen.findByText("Verify the durable conversation after a full browser reload.");
            expect(screen.getAllByLabelText("Message from you").map((message) => message.textContent)).toEqual([
                "Summarize the launch evidence.",
                "List the next verification step.",
            ]);

            cleanup();
            await closeMobiusTransport();
            render(<App />);
            await screen.findByRole("heading", { level: 2, name: "Summarize the launch evidence." });
            await screen.findByText("The launch is supported by the persisted evidence.");
            await screen.findByText("Verify the durable conversation after a full browser reload.");
            expect(screen.getAllByLabelText("Message from you").map((message) => message.textContent)).toEqual([
                "Summarize the launch evidence.",
                "List the next verification step.",
            ]);

            fireEvent.click(screen.getByRole("link", { name: "Connections" }));
            await screen.findByRole("heading", { level: 2, name: "Connections" });
            fireEvent.click(screen.getByRole("button", { name: "Create connection grant" }));
            fireEvent.change(screen.getByRole("textbox", { name: "Connection label" }), {
                target: { value: "Browser test connector" },
            });
            fireEvent.click(screen.getByRole("button", { name: "Create grant" }));
            await screen.findByText("Copy this grant now");

            const redeemed = await redeemMobiusBotConnectionGrant(
                { endpoint: window.location.origin },
                {
                    audience: "mobius-cloud",
                    connectorPrincipalId: "connector_browser_test",
                    grantId: definitionValue("Grant ID"),
                    grantSecret: definitionValue("Grant secret"),
                },
                AbortSignal.timeout(8_000),
            );
            const connector = createMobiusBotConnectorClient({
                connectionId: redeemed.connectionId,
                credentialProvider: new StaticMobiusCredentialProvider(redeemed.credential),
                endpoint: window.location.origin,
            });
            await connector.deliveryTargets.create({ alias: "launch-updates" }, AbortSignal.timeout(8_000));

            fireEvent.click(screen.getByRole("button", { name: "Refresh connections" }));
            await screen.findByText("Browser test connector");
            await screen.findByText("launch-updates");
            fireEvent.click(screen.getByRole("button", { name: "Approve target" }));
            await screen.findByText("Approved");

            fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
            fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
            await screen.findByText("Revoked");
            await screen.findByText("Disabled");
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });
});
