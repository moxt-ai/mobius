import { describe, expect, it } from "vitest";

import {
  AgentOption,
  ChannelConnection,
  ChannelHistory,
  CompletedRecordedTurn,
  FailedRecordedTurn,
  PendingRecordedTurn,
  RecordedActivity,
  RunningRecordedTurn,
} from "@/domain/channel";
import {
  AgentChatMessage,
  CompletedTurnState,
  type Conversation,
  FailedTurnState,
  PendingTurnState,
  RunningTurnState,
  StoppedTurnState,
  StoppingTurnState,
} from "@/domain/chat";
import { useChatStore } from "@/store/chat-store";

function readConversation(
  conversations: readonly Conversation[],
  conversationId: string,
): Conversation {
  for (const conversation of conversations) {
    if (conversation.id === conversationId) {
      return conversation;
    }
  }
  throw new Error("Conversation not found");
}

describe("Concurrent agent conversations", () => {
  it("Given a locally pending turn, When relay recovery marks it failed, Then the same conversation accepts another message", () => {
    useChatStore
      .getState()
      .configureChannel(
        new ChannelConnection(
          [new AgentOption("codex", "Codex")],
          "channel",
          "Local machine",
          "workspace",
        ),
        new ChannelHistory([]),
      );
    const turn = useChatStore.getState().beginTurn("stalled task");

    useChatStore
      .getState()
      .reconcileHistory(
        new ChannelHistory([
          new FailedRecordedTurn(
            "codex",
            turn.commandId,
            new Date("2026-09-04T02:00:00.000Z"),
            "stalled task",
            "",
            turn.sessionId,
            "daemon_start_timeout",
            "The local runtime did not acknowledge this request in time. Send it again.",
          ),
        ]),
      );

    const conversation = readConversation(
      useChatStore.getState().conversations,
      turn.conversationId,
    );
    const message = conversation.messages[1];
    expect(message).toBeInstanceOf(AgentChatMessage);
    if (!(message instanceof AgentChatMessage)) {
      throw new Error("Expected a recovered agent message");
    }
    expect(message.state).toBeInstanceOf(FailedTurnState);
    expect(conversation.isRunning).toBe(false);
    expect(() => useChatStore.getState().beginTurn("try again")).not.toThrow();
  });

  it("Given an agent is working, When the user starts another chat, Then both conversations remain independently usable", () => {
    const store = useChatStore.getState();
    store.configureChannel(
      new ChannelConnection(
        [new AgentOption("codex", "Codex")],
        "channel",
        "Local machine",
        "workspace",
      ),
      new ChannelHistory([]),
    );
    const firstConversationId = useChatStore.getState().activeConversationId;
    const firstTurn = useChatStore.getState().beginTurn("first task");

    useChatStore.getState().createConversation();

    const secondConversationId = useChatStore.getState().activeConversationId;
    expect(secondConversationId).not.toBe(firstConversationId);
    expect(useChatStore.getState().conversations).toHaveLength(2);
    const secondTurn = useChatStore.getState().beginTurn("second task");
    const runningConversations = useChatStore.getState().conversations;
    expect(
      readConversation(runningConversations, firstConversationId).isRunning,
    ).toBe(true);
    expect(
      readConversation(runningConversations, secondConversationId).isRunning,
    ).toBe(true);

    useChatStore.getState().selectConversation(firstConversationId);

    expect(useChatStore.getState().activeConversationId).toBe(
      firstConversationId,
    );
    useChatStore.getState().completeTurn(firstTurn, "attempt-1", "end_turn");
    useChatStore.getState().completeTurn(secondTurn, "attempt-2", "end_turn");
  });

  it("Given pending and running history, When the channel opens, Then both tasks are visible with their current state", () => {
    useChatStore
      .getState()
      .configureChannel(
        new ChannelConnection(
          [new AgentOption("codex", "Codex")],
          "channel",
          "Local machine",
          "workspace",
        ),
        new ChannelHistory([
          new PendingRecordedTurn(
            "codex",
            "pending-command",
            new Date("2026-09-04T02:00:00.000Z"),
            "pending task",
            "",
            "pending-session",
          ),
          new RunningRecordedTurn(
            "codex",
            "running-command",
            new Date("2026-09-04T02:01:00.000Z"),
            "running task",
            "partial response",
            "running-session",
            "running-attempt",
            [
              new RecordedActivity(
                "tool-1",
                "tool",
                '{"path":"package.json"}',
                ["/workspace/package.json"],
                "read_file",
                "package metadata",
                0,
                "completed",
                "Read package metadata",
                "read",
              ),
            ],
          ),
        ]),
      );

    const conversations = useChatStore.getState().conversations;
    const pending = readConversation(conversations, "pending-session");
    const running = readConversation(conversations, "running-session");
    const pendingMessage = pending.messages[1];
    const runningMessage = running.messages[1];

    expect(pending.isRunning).toBe(true);
    expect(running.isRunning).toBe(true);
    expect(pending.activeStateLabel).toBe("Pending");
    expect(running.activeStateLabel).toBe("Working");
    expect(pendingMessage).toBeInstanceOf(AgentChatMessage);
    expect(runningMessage).toBeInstanceOf(AgentChatMessage);
    if (
      !(pendingMessage instanceof AgentChatMessage) ||
      !(runningMessage instanceof AgentChatMessage)
    ) {
      throw new Error("Expected restored agent messages");
    }
    expect(pendingMessage.state).toBeInstanceOf(PendingTurnState);
    expect(pendingMessage.state.label).toBe("Pending");
    expect(runningMessage.state).toBeInstanceOf(RunningTurnState);
    expect(runningMessage.state.label).toBe("Working");
    expect(runningMessage.text).toBe("partial response");
    expect(runningMessage.activities).toMatchObject([
      {
        activityId: "tool-1",
        status: "completed",
        title: "Read package metadata",
      },
    ]);
  });

  it("Given a locally pending turn, When history advances it to completion, Then reconciliation preserves the live message identity", () => {
    useChatStore
      .getState()
      .configureChannel(
        new ChannelConnection(
          [new AgentOption("codex", "Codex")],
          "channel",
          "Local machine",
          "workspace",
        ),
        new ChannelHistory([]),
      );
    const turn = useChatStore.getState().beginTurn("local task");

    useChatStore
      .getState()
      .reconcileHistory(
        new ChannelHistory([
          new CompletedRecordedTurn(
            "codex",
            turn.commandId,
            new Date("2026-09-04T02:02:00.000Z"),
            "local task",
            "completed response",
            turn.sessionId,
            "completed-attempt",
            "end_turn",
          ),
        ]),
      );

    const conversation = readConversation(
      useChatStore.getState().conversations,
      turn.conversationId,
    );
    const message = conversation.messages[1];
    expect(message).toBeInstanceOf(AgentChatMessage);
    if (!(message instanceof AgentChatMessage)) {
      throw new Error("Expected reconciled agent message");
    }
    expect(message.id).toBe(turn.agentMessageId);
    expect(message.text).toBe("completed response");
    expect(message.state).toBeInstanceOf(CompletedTurnState);
    expect(conversation.isRunning).toBe(false);
  });

  it("Given a tool is running, When its ACP completion arrives, Then one timeline entry updates in place", () => {
    useChatStore
      .getState()
      .configureChannel(
        new ChannelConnection(
          [new AgentOption("codex", "Codex")],
          "channel",
          "Local machine",
          "workspace",
        ),
        new ChannelHistory([]),
      );
    const turn = useChatStore.getState().beginTurn("inspect package metadata");
    useChatStore.getState().startAgentTurn(turn, "attempt");
    useChatStore
      .getState()
      .recordAgentActivity(
        turn,
        new RecordedActivity(
          "tool-1",
          "tool",
          '{"path":"package.json"}',
          ["/workspace/package.json"],
          "read_file",
          "",
          0,
          "running",
          "Read package metadata",
          "read",
        ),
      );
    useChatStore
      .getState()
      .recordAgentActivity(
        turn,
        new RecordedActivity(
          "tool-1",
          "tool",
          '{"path":"package.json"}',
          ["/workspace/package.json"],
          "read_file",
          "package metadata",
          0,
          "completed",
          "Read package metadata",
          "read",
        ),
      );

    const conversation = readConversation(
      useChatStore.getState().conversations,
      turn.conversationId,
    );
    const message = conversation.messages[1];
    if (!(message instanceof AgentChatMessage)) {
      throw new Error("Expected an agent message");
    }
    expect(message.activities).toMatchObject([
      {
        activityId: "tool-1",
        output: "package metadata",
        status: "completed",
      },
    ]);
    useChatStore.getState().completeTurn(turn, "attempt", "end_turn");
  });

  it("Given the active agent turn is running, When stop is requested and ACP confirms cancellation, Then it becomes a resumable stopped turn", () => {
    useChatStore
      .getState()
      .configureChannel(
        new ChannelConnection(
          [new AgentOption("codex", "Codex")],
          "channel",
          "Local machine",
          "workspace",
        ),
        new ChannelHistory([]),
      );
    const turn = useChatStore.getState().beginTurn("long task");
    useChatStore.getState().startAgentTurn(turn, "attempt");

    useChatStore.getState().requestStop(turn);

    let conversation = readConversation(
      useChatStore.getState().conversations,
      turn.conversationId,
    );
    let message = conversation.messages[1];
    if (!(message instanceof AgentChatMessage)) {
      throw new Error("Expected an agent message");
    }
    expect(message.state).toBeInstanceOf(StoppingTurnState);
    expect(message.state.canStop).toBe(false);
    useChatStore.getState().completeTurn(turn, "attempt", "cancelled");

    conversation = readConversation(
      useChatStore.getState().conversations,
      turn.conversationId,
    );
    message = conversation.messages[1];
    if (!(message instanceof AgentChatMessage)) {
      throw new Error("Expected a stopped agent message");
    }
    expect(message.state).toBeInstanceOf(StoppedTurnState);
    expect(message.state.label).toBe("Stopped");
    expect(conversation.isRunning).toBe(false);
    expect(() => useChatStore.getState().beginTurn("continue")).not.toThrow();
  });

  it("Given cancelled history, When a new browser restores the channel, Then the turn is shown as stopped", () => {
    useChatStore
      .getState()
      .configureChannel(
        new ChannelConnection(
          [new AgentOption("codex", "Codex")],
          "channel",
          "Local machine",
          "workspace",
        ),
        new ChannelHistory([
          new CompletedRecordedTurn(
            "codex",
            "cancelled-command",
            new Date("2026-09-04T03:00:00.000Z"),
            "long task",
            "partial response",
            "cancelled-session",
            "cancelled-attempt",
            "cancelled",
          ),
        ]),
      );

    const conversation = readConversation(
      useChatStore.getState().conversations,
      "cancelled-session",
    );
    const message = conversation.messages[1];
    if (!(message instanceof AgentChatMessage)) {
      throw new Error("Expected a restored agent message");
    }
    expect(message.commandId).toBe("cancelled-command");
    expect(message.state).toBeInstanceOf(StoppedTurnState);
    expect(conversation.isRunning).toBe(false);
  });

  it("Given a Claude conversation replaced the initial Codex state, When the selector emits the stale Codex value, Then the restored conversation remains unchanged", () => {
    useChatStore
      .getState()
      .configureChannel(
        new ChannelConnection(
          [new AgentOption("claude-code", "Claude Code")],
          "channel",
          "Local machine",
          "workspace",
        ),
        new ChannelHistory([
          new CompletedRecordedTurn(
            "claude-code",
            "claude-command",
            new Date("2026-09-04T04:00:00.000Z"),
            "restore this conversation",
            "restored response",
            "claude-session",
            "claude-attempt",
            "end_turn",
          ),
        ]),
      );

    expect(() => useChatStore.getState().selectAgent("codex")).not.toThrow();

    const state = useChatStore.getState();
    const conversation = readConversation(
      state.conversations,
      state.activeConversationId,
    );
    expect(conversation.agentId).toBe("claude-code");
    expect(conversation.sessionId).toBe("claude-session");
    expect(conversation.messages).toHaveLength(2);
  });
});
