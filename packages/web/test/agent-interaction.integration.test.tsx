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
  SESSION_ELICITATION_RESPOND_KIND,
  SESSION_PREPARE_KIND,
  SESSION_PROMPT_KIND,
} from "@moxt-ai/mobius-protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
  it("Given a paired Agent has an unsent chat draft, When Agent settings is opened and closed, Then navigation stays in the page and preserves the draft", async () => {
    const paired = await pairDaemon();
    window.history.replaceState(
      null,
      "",
      `/channels/${encodeURIComponent(paired.channelId)}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      const prepare = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
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

      fireEvent.click(screen.getByRole("link", { name: "Back to chat" }));
      const restoredPromptInput = await screen.findByRole("textbox", {
        name: "Message the local agent",
      });
      expect(
        screen.getByDisplayValue("Keep this draft while viewing settings"),
      ).toBe(restoredPromptInput);
      expect(window.location.pathname).toBe(sessionPath);
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given a paired chat uses compact navigation, When the conversation drawer opens, Then it receives focus and isolates the conversation", async () => {
    const paired = await pairDaemon();
    window.history.replaceState(
      null,
      "",
      `/channels/${encodeURIComponent(paired.channelId)}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      const prepare = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
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
        expect(
          document.getElementById("main-content")?.hasAttribute("inert"),
        ).toBe(true);
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
    window.history.replaceState(
      null,
      "",
      `/channels/${encodeURIComponent(paired.channelId)}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      const prepare = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
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

  it("Given one New chat already exists, When a user requests New chat from another conversation, Then the existing draft is reopened without creating another", async () => {
    const paired = await pairDaemon();
    window.history.replaceState(
      null,
      "",
      `/channels/${encodeURIComponent(paired.channelId)}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      const initialPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, initialPreparation);
      await completeRenderedPrompt(
        paired.daemon,
        "Existing conversation",
        "Existing response",
      );

      const sidebar = screen.getByRole("complementary", {
        name: "Conversation sidebar",
      });
      fireEvent.click(
        within(sidebar).getByRole("button", { name: /New chat.*⌘ N/ }),
      );
      const draftPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
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

      fireEvent.click(
        within(sidebar).getByRole("button", { name: /New chat.*⌘ N/ }),
      );

      await waitFor(() => {
        expect(window.location.pathname).toBe(draftPath);
      });
      expect(
        screen.getByDisplayValue("Keep the existing New chat draft"),
      ).toBeTruthy();
      expect(
        within(conversations).getAllByRole("link", { name: /New chat/ }),
      ).toHaveLength(1);
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given a paired local Agent, When a user answers its form and sends a prompt, Then the Web app exchanges protocol messages and renders the response safely", async () => {
    const paired = await pairDaemon();
    window.history.replaceState(
      null,
      "",
      `/channels/${encodeURIComponent(paired.channelId)}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      const prepare = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, prepare);

      const promptInput = await screen.findByRole("textbox", {
        name: "Message the local agent",
      });
      await waitFor(() => {
        expect(promptInput.getAttribute("placeholder")).toContain(
          "Ask the local agent",
        );
      });

      fireEvent.change(promptInput, {
        target: { value: "Review the integration boundary" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      const prompt = decodeSessionPromptCommand(
        await paired.daemon.receive(SESSION_PROMPT_KIND),
      );
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
      fireEvent.click(
        within(formDialog).getByRole("button", { name: "Continue" }),
      );
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
        expect(
          screen.queryByRole("dialog", { name: "Agent information request" }),
        ).toBeNull();
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
