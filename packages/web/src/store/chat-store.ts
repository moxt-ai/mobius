import { create } from "zustand";

import {
  AgentOption,
  type ChannelConnection,
  type ChannelHistory,
  type RecordedActivity,
  type RecordedTurn,
} from "@/domain/channel";
import {
  AgentChatMessage,
  type AgentTurnState,
  CompletedTurnState,
  ConnectingRuntimeState,
  Conversation,
  FailedTurnState,
  PendingTurn,
  RunningTurnState,
  type RuntimeConnectionState,
  StoppedTurnState,
  StoppingTurnState,
  UserChatMessage,
} from "@/domain/chat";

const HISTORY_SYNC_ERROR_PREFIX = "history_sync_failed:";

export interface ChatStore {
  readonly activeConversationId: string;
  readonly agents: readonly AgentOption[];
  readonly announcement: string;
  readonly appendAgentText: (turn: PendingTurn, delta: string) => void;
  readonly beginTurn: (prompt: string) => PendingTurn;
  readonly completeTurn: (
    turn: PendingTurn,
    attemptId: string,
    stopReason: string,
  ) => void;
  readonly configureChannel: (
    connection: ChannelConnection,
    history: ChannelHistory,
  ) => void;
  readonly conversations: readonly Conversation[];
  readonly createConversation: () => void;
  readonly errorMessage: string;
  readonly failTurn: (turn: PendingTurn, message: string) => void;
  readonly machineName: string;
  readonly reconcileHistory: (history: ChannelHistory) => void;
  readonly recordAgentActivity: (
    turn: PendingTurn,
    activity: RecordedActivity,
  ) => void;
  readonly requestStop: (turn: PendingTurn) => void;
  readonly reportHistorySyncFailure: (message: string) => void;
  readonly runtime: RuntimeConnectionState;
  readonly selectConversation: (conversationId: string) => void;
  readonly selectAgent: (agentId: string) => void;
  readonly setDraft: (draft: string) => void;
  readonly setErrorMessage: (message: string) => void;
  readonly setRuntime: (runtime: RuntimeConnectionState) => void;
  readonly setSidebarOpen: (open: boolean) => void;
  readonly sidebarOpen: boolean;
  readonly startAgentTurn: (turn: PendingTurn, attemptId: string) => void;
  readonly workspaceName: string;
}

const defaultAgent = new AgentOption("codex", "Codex");
const initialConversation = Conversation.create(defaultAgent);

function readActiveConversation(state: ChatStore): Conversation {
  for (const conversation of state.conversations) {
    if (conversation.id === state.activeConversationId) {
      return conversation;
    }
  }
  throw new Error("Active conversation invariant failed");
}

function readConversation(
  conversations: readonly Conversation[],
  conversationId: string,
): Conversation {
  for (const conversation of conversations) {
    if (conversation.id === conversationId) {
      return conversation;
    }
  }
  throw new Error("Conversation invariant failed");
}

function readAgentMessage(
  conversation: Conversation,
  messageId: string,
): AgentChatMessage {
  for (const message of conversation.messages) {
    if (message instanceof AgentChatMessage && message.id === messageId) {
      return message;
    }
  }
  throw new Error("Agent message invariant failed");
}

function readAgent(
  agents: readonly AgentOption[],
  agentId: string,
): AgentOption {
  for (const agent of agents) {
    if (agent.id === agentId) {
      return agent;
    }
  }
  throw new Error("Agent invariant failed");
}

function readDefaultAgent(agents: readonly AgentOption[]): AgentOption {
  for (const agent of agents) {
    return agent;
  }
  throw new Error("Agent directory invariant failed");
}

function restoreConversations(
  agents: readonly AgentOption[],
  history: ChannelHistory,
): readonly Conversation[] {
  const sessionIds: string[] = [];
  for (const turn of history.turns) {
    if (!sessionIds.includes(turn.sessionId)) {
      sessionIds.push(turn.sessionId);
    }
  }

  const conversations: Conversation[] = [];
  for (const sessionId of sessionIds) {
    const turns = history.turns.filter((turn) => turn.sessionId === sessionId);
    const firstTurn = turns[0];
    if (firstTurn === undefined) {
      continue;
    }
    try {
      conversations.push(
        Conversation.restore(
          readAgent(agents, firstTurn.agentId),
          sessionId,
          turns,
        ),
      );
    } catch {}
  }
  return conversations;
}

function groupTurnsBySession(
  history: ChannelHistory,
): ReadonlyMap<string, readonly RecordedTurn[]> {
  const grouped = new Map<string, RecordedTurn[]>();
  for (const turn of history.turns) {
    const turns = grouped.get(turn.sessionId);
    if (turns === undefined) {
      grouped.set(turn.sessionId, [turn]);
    } else {
      turns.push(turn);
    }
  }
  return grouped;
}

function reconcileConversations(
  agents: readonly AgentOption[],
  conversations: readonly Conversation[],
  history: ChannelHistory,
): readonly Conversation[] {
  const turnsBySession = groupTurnsBySession(history);
  const existingSessionIds = new Set(
    conversations.map((conversation) => conversation.sessionId),
  );
  const discovered: Conversation[] = [];
  for (const [sessionId, turns] of turnsBySession) {
    if (existingSessionIds.has(sessionId)) {
      continue;
    }
    const firstTurn = turns[0];
    if (firstTurn === undefined) {
      continue;
    }
    try {
      discovered.push(
        Conversation.restore(
          readAgent(agents, firstTurn.agentId),
          sessionId,
          turns,
        ),
      );
    } catch {}
  }
  const reconciled = conversations.map((conversation) => {
    const turns = turnsBySession.get(conversation.sessionId);
    if (turns === undefined) {
      return conversation;
    }
    const firstTurn = turns[0];
    if (firstTurn === undefined) {
      return conversation;
    }
    try {
      return conversation.reconcileRecordedTurns(
        readAgent(agents, firstTurn.agentId),
        turns,
      );
    } catch {
      return conversation;
    }
  });
  return [...discovered, ...reconciled];
}

function countActiveConversations(
  conversations: readonly Conversation[],
): number {
  return conversations.filter((conversation) => conversation.isRunning).length;
}

function replaceConversation(
  conversations: readonly Conversation[],
  replacement: Conversation,
): readonly Conversation[] {
  return conversations.map((conversation) =>
    conversation.id === replacement.id ? replacement : conversation,
  );
}

function transitionAgentMessage(
  conversations: readonly Conversation[],
  turn: PendingTurn,
  state: AgentTurnState,
): readonly Conversation[] {
  const conversation = readConversation(conversations, turn.conversationId);
  const agentMessage = readAgentMessage(conversation, turn.agentMessageId);
  return replaceConversation(
    conversations,
    conversation.replaceAgentMessage(
      turn.agentMessageId,
      agentMessage.transition(state),
    ),
  );
}

export function selectActiveConversation(state: ChatStore): Conversation {
  return readActiveConversation(state);
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  activeConversationId: initialConversation.id,
  agents: [defaultAgent],
  announcement: "",
  appendAgentText: (turn, delta) => {
    set((state) => {
      const conversation = readConversation(
        state.conversations,
        turn.conversationId,
      );
      const agentMessage = readAgentMessage(conversation, turn.agentMessageId);
      return {
        conversations: replaceConversation(
          state.conversations,
          conversation.replaceAgentMessage(
            turn.agentMessageId,
            agentMessage.appendText(delta),
          ),
        ),
      };
    });
  },
  beginTurn: (prompt) => {
    const state = get();
    const conversation = readActiveConversation(state);
    if (conversation.isRunning) {
      throw new Error("A request is already running");
    }
    const commandId = crypto.randomUUID();
    const userMessage = UserChatMessage.create(commandId, prompt);
    const agentMessage = AgentChatMessage.create(commandId);
    const updatedConversation = conversation.addTurn(
      prompt,
      userMessage,
      agentMessage,
    );
    set({
      announcement: "Message sent. The agent is working.",
      conversations: replaceConversation(
        state.conversations,
        updatedConversation,
      ),
      errorMessage: "",
    });
    return new PendingTurn(
      conversation.agentId,
      commandId,
      conversation.id,
      conversation.sessionId,
      agentMessage.id,
    );
  },
  completeTurn: (turn, attemptId, stopReason) => {
    set((state) => {
      const conversation = readConversation(
        state.conversations,
        turn.conversationId,
      );
      const currentMessage = readAgentMessage(
        conversation,
        turn.agentMessageId,
      );
      const agentMessage =
        stopReason === "cancelled"
          ? currentMessage
              .withFallbackText("The agent stopped before returning text.")
              .transition(new StoppedTurnState(attemptId))
          : currentMessage
              .withFallbackText("The agent completed without returning text.")
              .transition(new CompletedTurnState(attemptId, stopReason));
      return {
        announcement:
          stopReason === "cancelled"
            ? "Agent response stopped."
            : "Agent response completed.",
        conversations: replaceConversation(
          state.conversations,
          conversation.replaceAgentMessage(turn.agentMessageId, agentMessage),
        ),
      };
    });
  },
  configureChannel: (connection, history) => {
    const restored = restoreConversations(connection.agents, history);
    const conversations =
      restored.length === 0
        ? [Conversation.create(readDefaultAgent(connection.agents))]
        : restored;
    const activeConversation = conversations[0];
    if (activeConversation === undefined) {
      throw new Error("Channel conversation invariant failed");
    }
    set({
      activeConversationId: activeConversation.id,
      agents: connection.agents,
      announcement: "",
      conversations,
      errorMessage: "",
      machineName: connection.machineName,
      runtime: new ConnectingRuntimeState(),
      sidebarOpen: false,
      workspaceName: connection.workspaceName,
    });
  },
  conversations: [initialConversation],
  createConversation: () => {
    const state = get();
    const activeConversation = readActiveConversation(state);
    if (activeConversation.messages.length === 0) {
      set({ sidebarOpen: false });
      return;
    }
    const conversation = Conversation.create(readDefaultAgent(state.agents));
    set({
      activeConversationId: conversation.id,
      conversations: [conversation, ...state.conversations],
      errorMessage: "",
      sidebarOpen: false,
    });
  },
  errorMessage: "",
  failTurn: (turn, message) => {
    set((state) => {
      const conversation = readConversation(
        state.conversations,
        turn.conversationId,
      );
      const agentMessage = readAgentMessage(conversation, turn.agentMessageId)
        .withFallbackText("The agent could not complete this request.")
        .transition(new FailedTurnState(message));
      return {
        announcement: `Agent response failed. ${message}`,
        conversations: replaceConversation(
          state.conversations,
          conversation.replaceAgentMessage(turn.agentMessageId, agentMessage),
        ),
        errorMessage:
          state.activeConversationId === turn.conversationId
            ? message
            : state.errorMessage,
      };
    });
  },
  machineName: "Local machine",
  reconcileHistory: (history) => {
    set((state) => {
      const previousActiveCount = countActiveConversations(state.conversations);
      const conversations = reconcileConversations(
        state.agents,
        state.conversations,
        history,
      );
      const activeCount = countActiveConversations(conversations);
      let announcement = state.announcement;
      if (activeCount > 0 && activeCount !== previousActiveCount) {
        announcement = `${activeCount.toString()} agent ${activeCount === 1 ? "task is" : "tasks are"} in progress.`;
      } else if (activeCount === 0 && previousActiveCount > 0) {
        announcement = "Background agent tasks completed.";
      }
      return {
        announcement,
        conversations,
        errorMessage: state.errorMessage.startsWith(HISTORY_SYNC_ERROR_PREFIX)
          ? ""
          : state.errorMessage,
      };
    });
  },
  recordAgentActivity: (turn, activity) => {
    set((state) => {
      const conversation = readConversation(
        state.conversations,
        turn.conversationId,
      );
      const agentMessage = readAgentMessage(
        conversation,
        turn.agentMessageId,
      ).recordActivity(activity);
      return {
        conversations: replaceConversation(
          state.conversations,
          conversation.replaceAgentMessage(turn.agentMessageId, agentMessage),
        ),
      };
    });
  },
  requestStop: (turn) => {
    set((state) => {
      const conversation = readConversation(
        state.conversations,
        turn.conversationId,
      );
      const agentMessage = readAgentMessage(conversation, turn.agentMessageId);
      if (!agentMessage.state.canStop) {
        return {};
      }
      return {
        announcement: "Stopping the agent response.",
        conversations: replaceConversation(
          state.conversations,
          conversation.replaceAgentMessage(
            turn.agentMessageId,
            agentMessage.transition(agentMessage.state.stop()),
          ),
        ),
      };
    });
  },
  reportHistorySyncFailure: (message) => {
    set({
      announcement: "Background task status could not be refreshed.",
      errorMessage: `${HISTORY_SYNC_ERROR_PREFIX} ${message}`,
    });
  },
  runtime: new ConnectingRuntimeState(),
  selectConversation: (conversationId) => {
    const state = get();
    readConversation(state.conversations, conversationId);
    set({
      activeConversationId: conversationId,
      errorMessage: "",
      sidebarOpen: false,
    });
  },
  selectAgent: (agentId) => {
    const state = get();
    const conversation = readActiveConversation(state);
    for (const agent of state.agents) {
      if (agent.id !== agentId) {
        continue;
      }
      set({
        conversations: replaceConversation(
          state.conversations,
          conversation.selectAgent(agent),
        ),
      });
      return;
    }
  },
  setDraft: (draft) => {
    set((state) => {
      const conversation = readActiveConversation(state);
      return {
        conversations: replaceConversation(
          state.conversations,
          conversation.updateDraft(draft),
        ),
      };
    });
  },
  setErrorMessage: (message) => {
    set({ errorMessage: message });
  },
  setRuntime: (runtime) => {
    set({ runtime });
  },
  setSidebarOpen: (open) => {
    set({ sidebarOpen: open });
  },
  sidebarOpen: false,
  startAgentTurn: (turn, attemptId) => {
    set((state) => {
      const conversation = readConversation(
        state.conversations,
        turn.conversationId,
      );
      const message = readAgentMessage(conversation, turn.agentMessageId);
      const nextState =
        message.state instanceof StoppingTurnState
          ? message.state.withAttemptId(attemptId)
          : new RunningTurnState(attemptId);
      return {
        conversations: transitionAgentMessage(
          state.conversations,
          turn,
          nextState,
        ),
      };
    });
  },
  workspaceName: "Local workspace",
}));
