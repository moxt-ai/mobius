import {
    decodeSessionElicitationRespondCommand,
    decodeSessionPrepareCommand,
    decodeSessionPromptCommand,
    encodeAgentActivityEvent,
    encodeAgentMessageDeltaEvent,
    encodeSessionCompletedEvent,
    encodeSessionElicitationRequestedEvent,
    encodeSessionElicitationResolvedEvent,
    encodeSessionStartedEvent,
    encodeSessionUsageUpdatedEvent,
    MOBIUS_API_PREFIX,
    SESSION_ELICITATION_RESPOND_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
} from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "@/app";
import { closeMobiusTransport } from "@/services/mobius-transport";
import {
    completeRenderedPrompt,
    pairDaemon,
    saveBrowserCredential,
    sendReadySession,
    setupWebIntegrationEnvironment,
} from "./app-integration-harness.ts";

setupWebIntegrationEnvironment();

describe.sequential("Agent interaction boundaries", () => {
    it("Given a paired Agent has an unsent chat draft, When Agent settings is opened and closed, Then its local details are visible and navigation preserves the draft", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare);

            const promptInput = await screen.findByRole("textbox", {
                name: "Message the local agent",
            });
            const sessionPath = `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(prepare.sessionId)}`;
            await waitFor(() => {
                expect(window.location.pathname).toBe(sessionPath);
            });
            fireEvent.change(promptInput, {
                target: { value: "Keep this draft while viewing settings" },
            });

            fireEvent.click(screen.getByRole("link", { name: "Agent settings" }));
            await screen.findByRole("heading", { level: 1, name: "Agent settings" });
            expect(window.location.pathname).toBe(`${sessionPath}/settings`);
            expect(screen.getByText("codex 0.153.0")).toBeTruthy();
            expect(screen.getByText("/usr/local/bin/codex")).toBeTruthy();

            fireEvent.click(screen.getByRole("link", { name: "Back to chat" }));
            const restoredPromptInput = await screen.findByRole("textbox", {
                name: "Message the local agent",
            });
            expect(screen.getByDisplayValue("Keep this draft while viewing settings")).toBe(restoredPromptInput);
            expect(window.location.pathname).toBe(sessionPath);
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a paired chat uses compact navigation, When the conversation drawer opens, Then it receives focus and isolates the conversation", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare);

            fireEvent.click(
                await screen.findByRole("button", {
                    name: "Open conversation sidebar",
                }),
            );

            const drawer = await screen.findByRole("dialog", {
                name: "Conversation sidebar",
            });
            const closeButton = within(drawer).getByRole("button", {
                name: "Close conversation sidebar",
            });
            await waitFor(() => {
                expect(drawer.getAttribute("aria-modal")).toBe("true");
                expect(document.getElementById("main-content")?.hasAttribute("inert")).toBe(true);
                expect(document.activeElement).toBe(closeButton);
            });
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a new chat starts with a Markdown heading, When the first message is sent, Then the compact header shows a readable title", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare);
            await completeRenderedPrompt(
                paired.daemon,
                "## Review the mobile layout\n\nKeep the narrow chat readable and calm.",
                "The mobile layout is ready for review.",
            );

            await screen.findByRole("heading", {
                level: 1,
                name: "Review the mobile layout",
            });
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a persisted response snapshot overlaps a streaming delta, When background synchronization and live delivery reconcile, Then the response renders the text once", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare);
            const promptInput = await screen.findByRole("textbox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });
            fireEvent.change(promptInput, { target: { value: "Say hello" } });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));

            vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
            vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "snapshot-race-attempt",
                    commandId: prompt.commandId,
                    kind: "session.started",
                    sessionId: prompt.sessionId,
                }),
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(screen.getByRole("button", { name: "Stop agent" })).toBeTruthy();

            const response = "Hello. How can I help?";
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: prompt.commandId,
                    kind: "agent.message.delta",
                    messageId: "",
                    sessionId: prompt.sessionId,
                    text: "Hello",
                }),
            );
            const responseSequence = await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: prompt.commandId,
                    kind: "agent.message.delta",
                    messageId: "",
                    sessionId: prompt.sessionId,
                    text: ". How can I help?",
                }),
            );
            const messagePageResponse = await fetch(
                new URL(
                    `${MOBIUS_API_PREFIX}/projects/${encodeURIComponent(paired.credential.projectId)}/sessions/${encodeURIComponent(prompt.sessionId)}/messages?limit=100`,
                    window.location.origin,
                ),
                {
                    headers: {
                        authorization: `Bearer ${paired.credential.hostToken}`,
                    },
                },
            );
            expect(messagePageResponse.status).toBe(200);
            expect(await messagePageResponse.json()).toMatchObject({
                lastCommittedSeq: responseSequence,
            });
            await vi.advanceTimersByTimeAsync(150);
            vi.useRealTimers();

            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionCompletedEvent({
                    commandId: prompt.commandId,
                    kind: "session.completed",
                    sessionId: prompt.sessionId,
                    stopReason: "end_turn",
                }),
            );
            await waitFor(() => {
                const message = screen.getByText(/Hello/);
                expect(message.textContent).toBe(response);
            });
        } finally {
            vi.useRealTimers();
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an Agent is working, When a queued follow-up is steered, Then it stays last while running and moves before the final response after completion", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare, [], {
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
                steering: true,
                unstableForkSession: true,
            });
            const promptInput = await screen.findByRole("textbox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });
            fireEvent.change(promptInput, { target: { value: "Inspect the failing workflow" } });
            const sendButton = screen.getByRole("button", { name: "Send message" });
            const sendSurface = sendButton.querySelector('[aria-hidden="true"]');
            if (!(sendSurface instanceof HTMLElement)) {
                throw new Error("Expected a visible send action surface");
            }
            expect(sendButton.hasAttribute("disabled")).toBe(false);
            expect(sendSurface.classList.contains("bg-foreground")).toBe(true);
            expect(sendSurface.classList.contains("text-background")).toBe(true);
            expect(sendSurface.classList.contains("bg-primary")).toBe(false);
            fireEvent.click(sendButton);
            const runningPrompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(runningPrompt).toMatchObject({ disposition: "reject", targetCommandId: "" });
            await paired.daemon.sendSessionEvent(
                runningPrompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "running-attempt",
                    commandId: runningPrompt.commandId,
                    kind: "session.started",
                    sessionId: runningPrompt.sessionId,
                }),
            );

            expect(await screen.findByRole("button", { name: "Stop agent" })).toBeTruthy();
            expect(screen.queryByText("Follow-up delivery")).toBeNull();
            expect(screen.queryByRole("button", { name: "Queue next" })).toBeNull();
            expect(screen.queryByRole("button", { name: "Steer now" })).toBeNull();
            const followUpInput = screen.getByRole("textbox", { name: "Message the local agent" });
            fireEvent.change(followUpInput, { target: { value: "Run the regression suite afterward" } });
            fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
            const followUpTray = await screen.findByRole("status", { name: "Pending follow-up messages" });
            expect(within(followUpTray).getByText("Run the regression suite afterward")).toBeTruthy();
            expect(within(followUpTray).getByText("Queued")).toBeTruthy();
            const steerQueuedMessage = within(followUpTray).getByRole("button", {
                name: "Steer queued message: Run the regression suite afterward",
            });
            expect(within(screen.getByRole("log")).queryByText("Run the regression suite afterward")).toBeNull();
            const composer = followUpInput.closest("footer");
            const composerForm = followUpInput.closest("form");
            if (composer === null || composerForm === null) {
                throw new Error("Expected the follow-up tray and prompt form in the active composer");
            }
            expect(composer.contains(followUpTray)).toBe(true);
            expect(followUpTray.nextElementSibling?.tagName).toBe("FORM");

            fireEvent.click(steerQueuedMessage);
            await waitFor(() => {
                expect(screen.queryByRole("status", { name: "Pending follow-up messages" })).toBeNull();
                expect(within(screen.getByRole("log")).getByText("Run the regression suite afterward")).toBeTruthy();
                const runningTranscript = screen.getAllByLabelText(/Message from/);
                expect(runningTranscript).toHaveLength(3);
                expect(runningTranscript[0]?.textContent).toContain("Inspect the failing workflow");
                expect(runningTranscript[1]?.getAttribute("aria-label")).toBe("Message from Codex");
                expect(runningTranscript[2]?.textContent).toContain("Run the regression suite afterward");
            });
            const steeringPrompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(steeringPrompt).toMatchObject({
                disposition: "steer",
                prompt: "Run the regression suite afterward",
                targetCommandId: runningPrompt.commandId,
            });
            await paired.daemon.sendSessionEvent(
                steeringPrompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "steering-attempt",
                    commandId: steeringPrompt.commandId,
                    kind: "session.started",
                    sessionId: steeringPrompt.sessionId,
                }),
            );
            await paired.daemon.sendSessionEvent(
                steeringPrompt.sessionId,
                encodeSessionCompletedEvent({
                    commandId: steeringPrompt.commandId,
                    kind: "session.completed",
                    sessionId: steeringPrompt.sessionId,
                    stopReason: "steered",
                }),
            );

            await paired.daemon.sendSessionEvent(
                runningPrompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: runningPrompt.commandId,
                    kind: "agent.message.delta",
                    messageId: "steered-answer",
                    sessionId: runningPrompt.sessionId,
                    text: "The original turn accepted steering.",
                }),
            );
            await paired.daemon.sendSessionEvent(
                runningPrompt.sessionId,
                encodeSessionCompletedEvent({
                    commandId: runningPrompt.commandId,
                    kind: "session.completed",
                    sessionId: runningPrompt.sessionId,
                    stopReason: "end_turn",
                }),
            );
            await waitFor(() => {
                expect(screen.queryByText("The agent completed without returning text.")).toBeNull();
                const transcript = screen
                    .getAllByLabelText(/Message from/)
                    .map((message) => message.textContent?.replaceAll(/\s+/g, " ").trim());
                expect(transcript).toEqual([
                    "Inspect the failing workflow",
                    "Run the regression suite afterward",
                    expect.stringContaining("The original turn accepted steering."),
                ]);
                expect(paired.daemon.available(SESSION_PROMPT_KIND)).toBe(0);
            });
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an Agent lacks native prompt queueing, When follow-ups are sent during a running Turn, Then Mobius runs them in order after the current Turn", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare, [], {
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
                steering: true,
                unstableForkSession: true,
            });
            const promptInput = await screen.findByRole("textbox", { name: "Message the local agent" });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });
            const initialPrompt = "Finish the current task";
            fireEvent.change(promptInput, { target: { value: initialPrompt } });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const runningPrompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            await paired.daemon.sendSessionEvent(
                runningPrompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "direct-steering-running-attempt",
                    commandId: runningPrompt.commandId,
                    kind: "session.started",
                    sessionId: runningPrompt.sessionId,
                }),
            );

            const followUps = ["Run the second task", "Run the third task"];
            for (const followUp of followUps) {
                const followUpInput = screen.getByRole("textbox", { name: "Message the local agent" });
                fireEvent.change(followUpInput, { target: { value: followUp } });
                fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
                const tray = await screen.findByRole("status", { name: "Pending follow-up messages" });
                expect(within(tray).getByText(followUp)).toBeTruthy();
                expect(within(screen.getByRole("log")).queryByText(followUp)).toBeNull();
            }
            expect(paired.daemon.available(SESSION_PROMPT_KIND)).toBe(0);

            await paired.daemon.sendSessionEvent(
                runningPrompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: runningPrompt.commandId,
                    kind: "agent.message.delta",
                    messageId: "first-answer",
                    sessionId: runningPrompt.sessionId,
                    text: "FIRST_COMPLETE",
                }),
            );
            await paired.daemon.sendSessionEvent(
                runningPrompt.sessionId,
                encodeSessionCompletedEvent({
                    commandId: runningPrompt.commandId,
                    kind: "session.completed",
                    sessionId: runningPrompt.sessionId,
                    stopReason: "end_turn",
                }),
            );

            const secondPrompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(secondPrompt).toMatchObject({
                disposition: "queue",
                prompt: followUps[0],
                targetCommandId: runningPrompt.commandId,
            });
            await paired.daemon.sendSessionEvent(
                secondPrompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "second-attempt",
                    commandId: secondPrompt.commandId,
                    kind: "session.started",
                    sessionId: secondPrompt.sessionId,
                }),
            );
            await paired.daemon.sendSessionEvent(
                secondPrompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: secondPrompt.commandId,
                    kind: "agent.message.delta",
                    messageId: "second-answer",
                    sessionId: secondPrompt.sessionId,
                    text: "SECOND_COMPLETE",
                }),
            );
            await paired.daemon.sendSessionEvent(
                secondPrompt.sessionId,
                encodeSessionCompletedEvent({
                    commandId: secondPrompt.commandId,
                    kind: "session.completed",
                    sessionId: secondPrompt.sessionId,
                    stopReason: "end_turn",
                }),
            );

            const thirdPrompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(thirdPrompt).toMatchObject({
                disposition: "queue",
                prompt: followUps[1],
                targetCommandId: runningPrompt.commandId,
            });
            await paired.daemon.sendSessionEvent(
                thirdPrompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "third-attempt",
                    commandId: thirdPrompt.commandId,
                    kind: "session.started",
                    sessionId: thirdPrompt.sessionId,
                }),
            );
            await paired.daemon.sendSessionEvent(
                thirdPrompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: thirdPrompt.commandId,
                    kind: "agent.message.delta",
                    messageId: "third-answer",
                    sessionId: thirdPrompt.sessionId,
                    text: "THIRD_COMPLETE",
                }),
            );
            await paired.daemon.sendSessionEvent(
                thirdPrompt.sessionId,
                encodeSessionCompletedEvent({
                    commandId: thirdPrompt.commandId,
                    kind: "session.completed",
                    sessionId: thirdPrompt.sessionId,
                    stopReason: "end_turn",
                }),
            );

            await waitFor(() => {
                const transcript = screen
                    .getAllByLabelText(/Message from/)
                    .map((message) => message.textContent?.replaceAll(/\s+/g, " ").trim());
                expect(transcript).toEqual([
                    initialPrompt,
                    expect.stringContaining("FIRST_COMPLETE"),
                    followUps[0],
                    expect.stringContaining("SECOND_COMPLETE"),
                    followUps[1],
                    expect.stringContaining("THIRD_COMPLETE"),
                ]);
            });
            expect(screen.queryByText("The agent completed without returning text.")).toBeNull();
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given chat has newer content below the viewport, When the reader is away from the tail, Then the latest control is a centered icon-only action", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare);
            await completeRenderedPrompt(paired.daemon, "Review the latest reply", "Newer reply content.");

            const viewport = (await screen.findByRole("log")).parentElement;
            if (!(viewport instanceof HTMLElement) || !viewport.classList.contains("conversation-scroll")) {
                throw new Error("Expected the conversation viewport");
            }
            viewport.scrollTop = -200;
            fireEvent.scroll(viewport);

            const latestButton = await screen.findByRole("button", {
                name: "Scroll to latest message",
            });
            expect(latestButton.classList.contains("left-1/2")).toBe(true);
            expect(latestButton.classList.contains("-translate-x-1/2")).toBe(true);
            expect(latestButton.textContent).toBe("");
            expect(latestButton.querySelector("svg")).not.toBeNull();
            expect(latestButton.getAttribute("title")).toBe("Scroll to latest message");
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given one New chat already exists, When a user requests New chat from another conversation, Then the existing draft is reopened without creating another", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const initialPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, initialPreparation);
            await completeRenderedPrompt(paired.daemon, "Existing conversation", "Existing response");

            const sidebar = screen.getByRole("complementary", {
                name: "Conversation sidebar",
            });
            fireEvent.click(within(sidebar).getByRole("button", { name: /New chat.*⌘ N/ }));
            const draftPreparation = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, draftPreparation);
            const draftPath = `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(draftPreparation.sessionId)}`;
            await waitFor(() => {
                expect(window.location.pathname).toBe(draftPath);
            });
            fireEvent.change(
                await screen.findByRole("textbox", {
                    name: "Message the local agent",
                }),
                { target: { value: "Keep the existing New chat draft" } },
            );

            const conversations = screen.getByRole("navigation", {
                name: "Conversations",
            });
            fireEvent.click(
                within(conversations).getByRole("link", {
                    name: /Existing conversation/,
                }),
            );
            await screen.findByRole("heading", {
                level: 1,
                name: "Existing conversation",
            });

            fireEvent.click(within(sidebar).getByRole("button", { name: /New chat.*⌘ N/ }));

            await waitFor(() => {
                expect(window.location.pathname).toBe(draftPath);
            });
            expect(screen.getByDisplayValue("Keep the existing New chat draft")).toBeTruthy();
            expect(within(conversations).getAllByRole("link", { name: /New chat/ })).toHaveLength(1);
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an Agent reports progress and returns a code sample, When the turn completes, Then the progress reads as message copy and the code offers one clear copy action", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare);

            const promptInput = await screen.findByRole("textbox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });
            fireEvent.change(promptInput, {
                target: { value: "Show the renderer entry point" },
            });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "progress-and-code-attempt",
                    commandId: prompt.commandId,
                    kind: "session.started",
                    sessionId: prompt.sessionId,
                }),
            );
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentActivityEvent({
                    activityId: "progress-1",
                    activityType: "progress",
                    commandId: prompt.commandId,
                    content: [],
                    detail: {
                        content: [],
                        input: "",
                        kind: "recorded",
                        output: "I found the **renderer** and am checking its code path.",
                    },
                    input: "",
                    kind: "agent.activity",
                    locations: [],
                    name: "",
                    output: "I found the **renderer** and am checking its code path.",
                    sequence: 0,
                    sessionId: prompt.sessionId,
                    status: "completed",
                    title: "Progress update",
                    toolKind: "",
                }),
            );
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: prompt.commandId,
                    kind: "agent.message.delta",
                    messageId: "",
                    sessionId: prompt.sessionId,
                    text: [
                        "Use this entry point:",
                        "",
                        "```typescript",
                        'const renderer = createRenderer({ mode: "streaming", preserveLongLines: true });',
                        "```",
                    ].join("\n"),
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
            await screen.findByText("Agent response completed.");

            const agentMessage = await screen.findByRole("article", {
                name: "Message from Codex",
            });
            const progress = within(agentMessage).getByRole("region", {
                name: "Agent progress update",
            });
            expect(within(progress).getByText("renderer")).toBeTruthy();
            expect(within(agentMessage).queryByTestId("agent-process-disclosure")).toBeNull();
            await waitFor(() => {
                expect(within(agentMessage).getByRole("button", { name: "Copy code" }).hasAttribute("disabled")).toBe(
                    false,
                );
            });
            expect(within(agentMessage).queryByRole("button", { name: "Download file" })).toBeNull();
            expect(within(agentMessage).getByText("typescript")).toBeTruthy();
            expect(agentMessage.textContent).toContain("preserveLongLines");
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given an Agent records Markdown reasoning and structured tool output, When the completed steps are expanded, Then the details read as formatted work instead of raw protocol text", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare);

            const promptInput = await screen.findByRole("textbox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });
            fireEvent.change(promptInput, {
                target: { value: "Inspect the workspace manifest" },
            });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    attemptId: "readable-steps-attempt",
                    commandId: prompt.commandId,
                    kind: "session.started",
                    sessionId: prompt.sessionId,
                }),
            );
            const reasoning = ["**Located the renderer.**", "", "Checking the output path."].join("\n");
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentActivityEvent({
                    activityId: "reasoning-1",
                    activityType: "reasoning",
                    commandId: prompt.commandId,
                    content: [],
                    detail: {
                        content: [],
                        input: "",
                        kind: "recorded",
                        output: reasoning,
                    },
                    input: "",
                    kind: "agent.activity",
                    locations: [],
                    name: "",
                    output: reasoning,
                    sequence: 0,
                    sessionId: prompt.sessionId,
                    status: "completed",
                    title: "Inspect renderer",
                    toolKind: "think",
                }),
            );
            const formattedOutput = ["{", '  "name": "mobius-workspace"', "}", ""].join("\n");
            const toolOutput = JSON.stringify({ exit_code: 0, formatted_output: formattedOutput }, null, 2);
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentActivityEvent({
                    activityId: "tool-1",
                    activityType: "tool",
                    commandId: prompt.commandId,
                    content: [],
                    detail: {
                        content: [],
                        input: "",
                        kind: "recorded",
                        output: toolOutput,
                    },
                    input: "",
                    kind: "agent.activity",
                    locations: ["package.json"],
                    name: "read_file",
                    output: toolOutput,
                    sequence: 1,
                    sessionId: prompt.sessionId,
                    status: "completed",
                    title: "Read workspace manifest",
                    toolKind: "read",
                }),
            );
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: prompt.commandId,
                    kind: "agent.message.delta",
                    messageId: "",
                    sessionId: prompt.sessionId,
                    text: "Workspace inspected.",
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

            const agentMessage = await screen.findByRole("article", {
                name: "Message from Codex",
            });
            const processDisclosure = within(agentMessage).getByTestId("agent-process-disclosure");
            const processSummary = processDisclosure.querySelector(":scope > summary");
            if (!(processSummary instanceof HTMLElement)) {
                throw new Error("Expected a step disclosure summary");
            }
            fireEvent.click(processSummary);

            const reasoningStep = within(agentMessage).getByText("Inspect renderer").closest("details");
            const reasoningSummary = reasoningStep?.querySelector(":scope > summary");
            if (!(reasoningSummary instanceof HTMLElement)) {
                throw new Error("Expected a reasoning step summary");
            }
            fireEvent.click(reasoningSummary);
            const emphasizedReasoning = within(agentMessage).getByText("Located the renderer.");
            expect(emphasizedReasoning.getAttribute("data-streamdown")).toBe("strong");
            expect(agentMessage.textContent).not.toContain("**Located the renderer.**");

            const toolStep = within(agentMessage).getByText("Read workspace manifest").closest("details");
            const toolSummary = toolStep?.querySelector(":scope > summary");
            if (!(toolSummary instanceof HTMLElement)) {
                throw new Error("Expected a tool step summary");
            }
            fireEvent.click(toolSummary);
            expect(agentMessage.textContent).toContain('"name": "mobius-workspace"');
            expect(agentMessage.textContent).not.toContain("formatted_output");
            expect(agentMessage.textContent).not.toContain("\\n");
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });

    it("Given a paired local Agent, When a user answers its form and sends a prompt, Then the Web app exchanges protocol messages and renders the response safely", async () => {
        const paired = await pairDaemon();
        window.history.replaceState(null, "", `/channels/${encodeURIComponent(paired.channelId)}`);
        window.localStorage.clear();
        saveBrowserCredential(paired.channelId, paired.credential);
        render(<App />);

        try {
            const prepare = decodeSessionPrepareCommand(await paired.daemon.receive(SESSION_PREPARE_KIND));
            await sendReadySession(paired.daemon, prepare);

            const promptInput = await screen.findByRole("textbox", {
                name: "Message the local agent",
            });
            await waitFor(() => {
                expect(promptInput.getAttribute("placeholder")).toContain("Ask the local agent");
            });

            fireEvent.change(promptInput, {
                target: { value: "Review the integration boundary" },
            });
            fireEvent.click(screen.getByRole("button", { name: "Send message" }));
            const prompt = decodeSessionPromptCommand(await paired.daemon.receive(SESSION_PROMPT_KIND));
            expect(prompt).toMatchObject({
                prompt: "Review the integration boundary",
                sessionId: prepare.sessionId,
            });
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionStartedEvent({
                    commandId: prompt.commandId,
                    kind: "session.started",
                    attemptId: "attempt-1",
                    sessionId: prompt.sessionId,
                }),
            );

            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionElicitationRequestedEvent({
                    accepted: false,
                    commandId: prompt.commandId,
                    elicitationId: "form-1",
                    fields: [
                        {
                            defaultBooleanValue: false,
                            defaultNumberValue: 0,
                            defaultStringValue: "",
                            description: "Optional count",
                            format: "",
                            hasDefaultValue: false,
                            maximum: "",
                            maximumLength: "",
                            minimum: "",
                            minimumLength: "",
                            name: "count",
                            options: [],
                            pattern: "",
                            required: false,
                            title: "Count",
                            type: "number",
                        },
                        {
                            defaultBooleanValue: false,
                            defaultNumberValue: 0,
                            defaultStringValue: "bug",
                            description: "",
                            format: "",
                            hasDefaultValue: true,
                            maximum: "",
                            maximumLength: "",
                            minimum: "",
                            minimumLength: "",
                            name: "labels",
                            options: [
                                { description: "", label: "Bug", value: "bug" },
                                {
                                    description: "",
                                    label: "Frontend",
                                    value: "frontend",
                                },
                            ],
                            pattern: "",
                            required: false,
                            title: "Labels",
                            type: "select",
                        },
                    ],
                    interactionId: "form-interaction",
                    kind: "session.elicitation.requested",
                    message: "Choose issue details",
                    mode: "form",
                    sessionId: prepare.sessionId,
                    url: "",
                }),
            );
            const formDialog = await screen.findByRole("dialog", {
                name: "Agent information request",
            });
            const labels = within(formDialog).getByLabelText("Labels");
            expect(labels).toBeInstanceOf(HTMLSelectElement);
            if (!(labels instanceof HTMLSelectElement)) {
                throw new Error("Expected a select field");
            }
            expect(labels.value).toBe("bug");
            fireEvent.click(within(formDialog).getByRole("button", { name: "Continue" }));
            const response = decodeSessionElicitationRespondCommand(
                await paired.daemon.receive(SESSION_ELICITATION_RESPOND_KIND),
            );
            expect(response).toMatchObject({
                action: "accept",
                content: '{"labels":"bug"}',
                interactionId: "form-interaction",
                sessionId: prepare.sessionId,
            });
            await paired.daemon.sendSessionEvent(
                response.sessionId,
                encodeSessionElicitationResolvedEvent({
                    action: "accept",
                    interactionId: response.interactionId,
                    kind: "session.elicitation.resolved",
                    sessionId: response.sessionId,
                }),
            );
            await waitFor(() => {
                expect(screen.queryByRole("dialog", { name: "Agent information request" })).toBeNull();
            });
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentActivityEvent({
                    activityId: "tool-1",
                    activityType: "tool",
                    commandId: prompt.commandId,
                    content: [],
                    detail: { kind: "unrecorded" },
                    input: '{"path":"package.json"}',
                    kind: "agent.activity",
                    locations: ["package.json"],
                    name: "read_file",
                    output: "workspace manifest",
                    sequence: 0,
                    sessionId: prompt.sessionId,
                    status: "completed",
                    title: "Read workspace manifest",
                    toolKind: "read",
                }),
            );
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId: prompt.commandId,
                    kind: "agent.message.delta",
                    messageId: "",
                    sessionId: prompt.sessionId,
                    text: "Completed **safely**. [unsafe](javascript:alert(1)) <script>alert(1)</script>",
                }),
            );
            await paired.daemon.sendSessionEvent(
                prompt.sessionId,
                encodeSessionUsageUpdatedEvent({
                    costAmount: 0.25,
                    costCurrency: "USD",
                    hasCost: true,
                    kind: "session.usage.updated",
                    sessionId: prompt.sessionId,
                    size: 200_000,
                    source: "context",
                    used: 50_000,
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

            const agentMessage = await screen.findByRole("article", {
                name: "Message from Codex",
            });
            await waitFor(() => {
                expect(agentMessage.textContent).toContain("Completed safely");
                expect(agentMessage.textContent).toContain("Read workspace manifest");
            });
            expect(document.querySelector("script")).toBeNull();
            expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
            await waitFor(() => {
                const usage = document.querySelector('[aria-label^="Agent usage:"]');
                expect(usage?.getAttribute("aria-label")).toContain("25%");
                expect(usage?.getAttribute("aria-label")).toContain("$0.25 USD");
            });
        } finally {
            cleanup();
            await closeMobiusTransport();
            paired.daemon.close();
        }
    });
});
