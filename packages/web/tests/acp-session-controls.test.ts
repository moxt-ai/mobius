import type {
  AgentContentEvent,
  SessionCommandsUpdatedEvent,
  SessionConfigUpdatedEvent,
  SessionElicitationRequestedEvent,
  SessionInfoUpdatedEvent,
  SessionPermissionRequestedEvent,
  SessionReadyEvent,
  SessionUsageUpdatedEvent,
} from "@moxt-ai/mobius-web-sdk";
import { describe, expect, it } from "vitest";

import {
  AgentOption,
  ChannelConnection,
  ChannelHistory,
  RecordedSession,
} from "@/domain/channel";
import {
  AgentChatMessage,
  ReadySessionState,
  UnpreparedSessionState,
} from "@/domain/chat";
import { useChatStore } from "@/store/chat-store";

const ready: SessionReadyEvent = {
  additionalDirectories: [],
  agentId: "codex",
  agentName: "Codex",
  agentVersion: "1.2.3",
  capabilities: {
    additionalDirectories: true,
    audioPrompt: false,
    closeSession: true,
    deleteSession: false,
    embeddedContextPrompt: true,
    imagePrompt: true,
    listSessions: false,
    loadSession: true,
    resumeSession: true,
  },
  commands: [],
  configOptions: [
    {
      booleanValue: false,
      category: "model",
      currentValue: "gpt-5",
      description: "Model used for this session",
      id: "model",
      name: "Model",
      type: "select",
      values: [
        {
          description: "",
          groupId: "",
          groupName: "",
          name: "GPT-5",
          value: "gpt-5",
        },
      ],
    },
  ],
  directoryId: "root",
  directoryLabel: "mobius",
  kind: "session.ready",
  protocolVersion: 1,
  requestId: "prepare-1",
  restored: true,
  sessionId: "session-1",
};

function configure(): void {
  useChatStore
    .getState()
    .configureChannel(
      new ChannelConnection(
        [new AgentOption("codex", "Codex")],
        "channel",
        "Local machine",
        "mobius",
      ),
      new ChannelHistory([]),
    );
}

describe("ACP session controls", () => {
  it("Given one agent is still preparing, When the user switches agents, Then stale readiness and failure results cannot replace the new selection", () => {
    useChatStore
      .getState()
      .configureChannel(
        new ChannelConnection(
          [
            new AgentOption("codex", "Codex"),
            new AgentOption("claude", "Claude Code"),
          ],
          "channel",
          "Local machine",
          "mobius",
        ),
        new ChannelHistory([]),
      );
    const sessionId = useChatStore.getState().conversations[0]?.sessionId ?? "";
    useChatStore.getState().setSessionPreparing(sessionId);

    useChatStore.getState().selectAgent("claude");
    useChatStore.getState().applySessionReady({ ...ready, sessionId });
    useChatStore
      .getState()
      .setSessionPreparationFailed(
        sessionId,
        "codex",
        "root",
        [],
        "operation_timeout",
      );
    useChatStore
      .getState()
      .reconcileHistory(
        new ChannelHistory(
          [],
          [
            new RecordedSession(
              [],
              ready.agentId,
              ready.agentName,
              ready.agentVersion,
              ready.capabilities,
              ready.commands,
              ready.configOptions,
              ready.directoryId,
              ready.directoryLabel,
              [],
              [],
              true,
              sessionId,
              "Stale Codex session",
              "2026-09-04T08:00:00.000Z",
              [],
            ),
          ],
        ),
      );

    const state = useChatStore.getState();
    expect(state.conversations[0]?.agentId).toBe("claude");
    expect(state.conversations[0]?.session).toBeInstanceOf(
      UnpreparedSessionState,
    );
    expect(state.errorMessage).toBe("");
  });

  it("Given agent capabilities were preloaded, When a directory is selected before the first turn, Then the conversation keeps its Mobius session identity", () => {
    configure();
    const sessionId = useChatStore.getState().conversations[0]?.sessionId ?? "";
    useChatStore.getState().applySessionReady({ ...ready, sessionId });

    useChatStore.getState().toggleAdditionalDirectory({
      directoryId: "packages",
      name: "packages",
    });
    useChatStore.getState().applySessionReady({ ...ready, sessionId });
    useChatStore
      .getState()
      .setSessionPreparationFailed(
        sessionId,
        "codex",
        "root",
        [],
        "operation_timeout",
      );
    useChatStore
      .getState()
      .reconcileHistory(
        new ChannelHistory(
          [],
          [
            new RecordedSession(
              [],
              ready.agentId,
              ready.agentName,
              ready.agentVersion,
              ready.capabilities,
              ready.commands,
              ready.configOptions,
              ready.directoryId,
              ready.directoryLabel,
              [],
              [],
              true,
              sessionId,
              "Stale root workspace",
              "2026-09-04T08:00:00.000Z",
              [],
            ),
          ],
        ),
      );

    expect(useChatStore.getState().conversations[0]).toMatchObject({
      additionalDirectories: [{ directoryId: "packages", name: "packages" }],
      sessionId,
      session: expect.any(UnpreparedSessionState),
    });
    expect(useChatStore.getState().errorMessage).toBe("");
  });

  it("Given an ACP session is prepared, When capabilities, configuration, commands, usage, and info arrive, Then the conversation exposes the complete live session state", () => {
    configure();
    const sessionId = useChatStore.getState().conversations[0]?.sessionId ?? "";
    useChatStore.getState().applySessionReady({ ...ready, sessionId });
    useChatStore.getState().applySessionConfig({
      configOptions: [
        {
          booleanValue: false,
          category: "model",
          currentValue: "gpt-5.1",
          description: "Model used for this session",
          id: "model",
          name: "Model",
          type: "select",
          values: [
            {
              description: "",
              groupId: "",
              groupName: "",
              name: "GPT-5",
              value: "gpt-5",
            },
            {
              description: "",
              groupId: "",
              groupName: "",
              name: "GPT-5.1",
              value: "gpt-5.1",
            },
          ],
        },
      ],
      kind: "session.config.updated",
      protocolVersion: 1,
      requestId: "config-1",
      sessionId,
    } satisfies SessionConfigUpdatedEvent);
    useChatStore.getState().applySessionCommands({
      commands: [
        {
          description: "Review changes",
          inputHint: "optional path",
          name: "review",
        },
      ],
      kind: "session.commands.updated",
      protocolVersion: 1,
      sessionId,
    } satisfies SessionCommandsUpdatedEvent);
    useChatStore.getState().applySessionUsage({
      costAmount: 0.42,
      costCurrency: "USD",
      hasCost: true,
      kind: "session.usage.updated",
      protocolVersion: 1,
      sessionId,
      size: 200_000,
      used: 50_000,
    } satisfies SessionUsageUpdatedEvent);
    useChatStore.getState().applySessionInfo({
      kind: "session.info.updated",
      protocolVersion: 1,
      sessionId,
      title: "ACP feature audit",
      updatedAt: "2026-09-04T08:00:00.000Z",
    } satisfies SessionInfoUpdatedEvent);

    const conversation = useChatStore.getState().conversations[0];
    expect(conversation?.session).toBeInstanceOf(ReadySessionState);
    expect(conversation?.session.configOptions[0]?.currentValue).toBe(
      "gpt-5.1",
    );
    expect(conversation?.session.commands[0]?.name).toBe("review");
    expect(conversation?.session.usage.percent).toBe(25);
    expect(conversation?.session.usage.costLabel).toBe("$0.42 USD");
    expect(conversation?.session.updatedAt).toBe("2026-09-04T08:00:00.000Z");
    expect(conversation?.title).toBe("ACP feature audit");
  });

  it("Given an agent supplied a session title, When it explicitly clears that title, Then the conversation returns to its prompt-derived title", () => {
    configure();
    const turn = useChatStore
      .getState()
      .beginTurn("Investigate reconnect state");
    useChatStore.getState().applySessionInfo({
      kind: "session.info.updated",
      protocolVersion: 1,
      sessionId: turn.sessionId,
      title: "Agent-provided title",
      updatedAt: "2026-09-04T08:00:00.000Z",
    });
    useChatStore.getState().applySessionInfo({
      kind: "session.info.updated",
      protocolVersion: 1,
      sessionId: turn.sessionId,
      title: "",
      updatedAt: "2026-09-04T08:01:00.000Z",
    });

    expect(useChatStore.getState().conversations[0]?.title).toBe(
      "Investigate reconnect state",
    );
  });

  it("Given an agent pauses for user input, When permission and form elicitation arrive, Then they remain actionable until resolved", () => {
    configure();
    const sessionId = useChatStore.getState().conversations[0]?.sessionId ?? "";
    useChatStore.getState().applySessionReady({ ...ready, sessionId });
    const permission = {
      commandId: "command-1",
      interactionId: "permission-1",
      kind: "session.permission.requested",
      options: [
        { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
      protocolVersion: 1,
      sessionId,
      title: "Run project checks",
      toolCallId: "tool-1",
      toolKind: "execute",
    } satisfies SessionPermissionRequestedEvent;
    const elicitation = {
      accepted: false,
      commandId: "command-1",
      elicitationId: "form-1",
      fields: [
        {
          defaultBooleanValue: false,
          defaultNumberValue: 0,
          defaultStringValue: "main",
          description: "Branch to inspect",
          format: "",
          hasDefaultValue: true,
          maximum: "",
          maximumLength: "64",
          minimum: "",
          minimumLength: "1",
          name: "branch",
          options: [],
          pattern: "",
          required: true,
          title: "Branch",
          type: "string",
        },
      ],
      interactionId: "elicitation-1",
      kind: "session.elicitation.requested",
      message: "Choose the branch",
      mode: "form",
      protocolVersion: 1,
      sessionId,
      url: "",
    } satisfies SessionElicitationRequestedEvent;

    useChatStore.getState().applySessionPermission(permission);
    useChatStore.getState().applySessionElicitation(elicitation);
    let conversation = useChatStore.getState().conversations[0];
    expect(conversation?.session.permissions).toEqual([permission]);
    expect(conversation?.session.elicitations).toEqual([elicitation]);

    useChatStore.getState().resolveSessionPermission("permission-1", sessionId);
    useChatStore.getState().resolveSessionElicitation({
      action: "decline",
      interactionId: "elicitation-1",
      kind: "session.elicitation.resolved",
      protocolVersion: 1,
      sessionId,
    });
    conversation = useChatStore.getState().conversations[0];
    expect(conversation?.session.permissions).toEqual([]);
    expect(conversation?.session.elicitations).toEqual([]);
  });

  it("Given a prompt has image and resource attachments, When rich agent content streams back, Then both sides retain non-text content", () => {
    configure();
    const store = useChatStore.getState();
    store.addDraftImage({
      data: "aW1hZ2U=",
      mimeType: "image/png",
      name: "screen.png",
    });
    store.addDraftResource({
      mimeType: "text/plain",
      name: "notes.txt",
      text: "remember this",
      type: "embedded",
      uri: "attachment:///notes.txt",
    });
    const turn = useChatStore.getState().beginTurn("");
    useChatStore.getState().startAgentTurn(turn, "attempt-1");
    useChatStore.getState().recordAgentContent({
      commandId: turn.commandId,
      content: {
        data: "",
        mimeType: "text/plain",
        name: "result.txt",
        newText: "",
        oldText: "",
        path: "",
        terminalId: "",
        text: "structured result",
        type: "resource",
        uri: "resource:///result.txt",
      },
      contentId: "content-1",
      kind: "agent.content",
      messageId: "message-1",
      protocolVersion: 1,
      sessionId: turn.sessionId,
    } satisfies AgentContentEvent);

    const conversation = useChatStore.getState().conversations[0];
    expect(conversation?.draftImages).toEqual([]);
    expect(conversation?.draftResources).toEqual([]);
    expect(conversation?.messages[0]).toMatchObject({
      images: [{ name: "screen.png" }],
      resources: [{ name: "notes.txt" }],
    });
    const response = conversation?.messages[1];
    expect(response).toBeInstanceOf(AgentChatMessage);
    if (!(response instanceof AgentChatMessage)) {
      throw new Error("Expected an agent response");
    }
    expect(response.contents).toMatchObject([
      { contentId: "content-1", content: { text: "structured result" } },
    ]);
  });

  it("Given URL elicitation was accepted, When completion has not arrived, Then a restored browser keeps showing the pending out-of-band interaction", () => {
    configure();
    const sessionId = useChatStore.getState().conversations[0]?.sessionId ?? "";
    useChatStore.getState().applySessionReady({ ...ready, sessionId });
    useChatStore.getState().applySessionElicitation({
      accepted: false,
      commandId: "command-1",
      elicitationId: "connect-1",
      fields: [],
      interactionId: "elicitation-url-1",
      kind: "session.elicitation.requested",
      message: "Connect an account",
      mode: "url",
      protocolVersion: 1,
      sessionId,
      url: "https://example.com/connect",
    });

    useChatStore.getState().resolveSessionElicitation({
      action: "accept",
      interactionId: "elicitation-url-1",
      kind: "session.elicitation.resolved",
      protocolVersion: 1,
      sessionId,
    });
    let conversation = useChatStore.getState().conversations[0];
    expect(conversation?.session.elicitations).toMatchObject([
      { accepted: true, interactionId: "elicitation-url-1" },
    ]);

    useChatStore.getState().resolveSessionElicitation({
      action: "complete",
      interactionId: "elicitation-url-1",
      kind: "session.elicitation.resolved",
      protocolVersion: 1,
      sessionId,
    });
    conversation = useChatStore.getState().conversations[0];
    expect(conversation?.session.elicitations).toEqual([]);
  });

  it("Given a relay retained an ACP session snapshot, When a browser opens the channel again, Then its workspace, settings, usage, commands, and pending interactions are restored", () => {
    const acceptedUrlElicitation = {
      accepted: true,
      commandId: "command-1",
      elicitationId: "connect-1",
      fields: [],
      interactionId: "elicitation-url-1",
      kind: "session.elicitation.requested",
      message: "Connect an account",
      mode: "url",
      protocolVersion: 1,
      sessionId: "session-restored",
      url: "https://example.com/connect",
    } satisfies SessionElicitationRequestedEvent;
    const permission = {
      commandId: "command-1",
      interactionId: "permission-1",
      kind: "session.permission.requested",
      options: [
        { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
      ],
      protocolVersion: 1,
      sessionId: "session-restored",
      title: "Run project checks",
      toolCallId: "tool-1",
      toolKind: "execute",
    } satisfies SessionPermissionRequestedEvent;
    const usage = {
      costAmount: 0.12,
      costCurrency: "USD",
      hasCost: true,
      kind: "session.usage.updated",
      protocolVersion: 1,
      sessionId: "session-restored",
      size: 100_000,
      used: 40_000,
    } satisfies SessionUsageUpdatedEvent;
    const snapshot = new RecordedSession(
      [{ directoryId: "docs", name: "docs" }],
      ready.agentId,
      ready.agentName,
      ready.agentVersion,
      ready.capabilities,
      [{ description: "Review changes", inputHint: "", name: "review" }],
      ready.configOptions,
      "src",
      "src",
      [acceptedUrlElicitation],
      [permission],
      true,
      "session-restored",
      "Restored ACP work",
      "2026-09-04T08:00:00.000Z",
      [usage],
    );

    useChatStore
      .getState()
      .configureChannel(
        new ChannelConnection(
          [new AgentOption("codex", "Codex")],
          "channel",
          "Local machine",
          "mobius",
        ),
        new ChannelHistory([], [snapshot]),
      );

    const conversation = useChatStore.getState().conversations[0];
    expect(conversation).toMatchObject({
      additionalDirectories: [{ directoryId: "docs", name: "docs" }],
      directoryId: "src",
      directoryLabel: "src",
      sessionId: "session-restored",
      title: "Restored ACP work",
    });
    expect(conversation?.session).toBeInstanceOf(ReadySessionState);
    expect(conversation?.session.commands).toMatchObject([{ name: "review" }]);
    expect(conversation?.session.permissions).toEqual([permission]);
    expect(conversation?.session.elicitations).toEqual([
      acceptedUrlElicitation,
    ]);
    expect(conversation?.session.usage.percent).toBe(40);
  });
});
