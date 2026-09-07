import {
  decodeSessionConfigureCommand,
  decodeSessionPrepareCommand,
  decodeSessionPromptCommand,
  encodeSessionCompletedEvent,
  encodeSessionConfigUpdatedEvent,
  encodeSessionInfoUpdatedEvent,
  encodeSessionStartedEvent,
  SESSION_CONFIGURE_KIND,
  SESSION_PREPARE_KIND,
  SESSION_PROMPT_KIND,
  type SessionConfigOption,
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

describe.sequential("Session persistence boundaries", () => {
  it("Given an Agent previously used a selected model configuration, When a user starts another conversation with that Agent, Then the new Session restores that configuration by default", async () => {
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
      await sendReadySession(
        paired.daemon,
        initialPreparation,
        modelConfigOptions("test-small"),
      );

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
      fireEvent.click(
        await screen.findByRole("option", { name: "Test Large" }),
      );

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

      await completeRenderedPrompt(
        paired.daemon,
        "Remember this model",
        "MODEL-REMEMBERED",
      );
      fireEvent.click(
        within(
          screen.getByRole("complementary", {
            name: "Conversation sidebar",
          }),
        ).getByRole("button", { name: /New chat.*⌘ N/ }),
      );

      const nextPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(
        paired.daemon,
        nextPreparation,
        modelConfigOptions("test-small"),
      );
      const restoredConfiguration = decodeSessionConfigureCommand(
        await paired.daemon.receive(SESSION_CONFIGURE_KIND),
      );
      expect(restoredConfiguration).toMatchObject({
        agentId: "codex",
        configId: "model",
        sessionId: nextPreparation.sessionId,
        value: "test-large",
      });
      expect(
        screen
          .getByRole("textbox", { name: "Message the local agent" })
          .getAttribute("placeholder"),
      ).toBe("Loading agent settings");
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

  it("Given several persisted Sessions, When a user selects an older Session and reloads, Then its route and selection are restored", async () => {
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
      const olderPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, olderPreparation);
      await completeRenderedPrompt(
        paired.daemon,
        "Older persisted prompt",
        "OLDER-RESPONSE",
      );

      fireEvent.click(
        within(
          screen.getByRole("complementary", {
            name: "Conversation sidebar",
          }),
        ).getByRole("button", { name: /New chat.*⌘ N/ }),
      );
      const newerPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, newerPreparation);
      await completeRenderedPrompt(
        paired.daemon,
        "Newest persisted prompt",
        "NEWEST-RESPONSE",
      );
      expect(window.location.pathname).toBe(
        `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(newerPreparation.sessionId)}`,
      );

      const conversations = await screen.findByRole("navigation", {
        name: "Conversations",
      });
      const conversationLinks = within(conversations).getAllByRole("link");
      expect(conversationLinks).toHaveLength(2);
      expect(conversationLinks[0]?.textContent).toContain(
        "Newest persisted prompt",
      );
      expect(conversationLinks[1]?.textContent).toContain(
        "Older persisted prompt",
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
      render(<App />);
      const resumedPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      expect(resumedPreparation.sessionId).toBe(olderPreparation.sessionId);
      await sendReadySession(paired.daemon, resumedPreparation);

      const restoredConversations = await screen.findByRole("navigation", {
        name: "Conversations",
      });
      await waitFor(() => {
        const conversationButtons = within(restoredConversations).getAllByRole(
          "link",
        );
        expect(conversationButtons).toHaveLength(2);
        expect(conversationButtons[0]?.textContent).toContain(
          "Newest persisted prompt",
        );
        expect(conversationButtons[1]?.textContent).toContain(
          "Older persisted prompt",
        );
      });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
        "Older persisted prompt",
      );
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given a titled Session has no Turns, When the Web app reloads, Then the same Session remains visible and resumes preparation", async () => {
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
      const resumedPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
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
      const prompt = decodeSessionPromptCommand(
        await paired.daemon.receive(SESSION_PROMPT_KIND),
      );
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
      const resumedPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
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
