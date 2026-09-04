import type {
  AgentContentEvent,
  PromptImage,
  PromptResource,
  SessionCommandsUpdatedEvent,
  SessionConfigUpdatedEvent,
  SessionElicitationRequestedEvent,
  SessionElicitationResolvedEvent,
  SessionInfoUpdatedEvent,
  SessionPermissionRequestedEvent,
  SessionReadyEvent,
  SessionUsageUpdatedEvent,
  WorkspaceEntry,
} from "@moxt-ai/mobius-web-sdk";
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
  ReadySessionState,
  RunningTurnState,
  type RuntimeConnectionState,
  StoppedTurnState,
  StoppingTurnState,
  UserChatMessage,
} from "@/domain/chat";

const HISTORY_SYNC_ERROR_PREFIX = "history_sync_failed:";

export interface ChatStore {
  readonly addDraftImage: (image: PromptImage) => void;
  readonly addDraftResource: (resource: PromptResource) => void;
  readonly applySessionCommands: (event: SessionCommandsUpdatedEvent) => void;
  readonly applySessionConfig: (event: SessionConfigUpdatedEvent) => void;
  readonly applySessionElicitation: (
    event: SessionElicitationRequestedEvent,
  ) => void;
  readonly applySessionInfo: (event: SessionInfoUpdatedEvent) => void;
  readonly applySessionPermission: (
    event: SessionPermissionRequestedEvent,
  ) => void;
  readonly applySessionReady: (event: SessionReadyEvent) => void;
  readonly applySessionUsage: (event: SessionUsageUpdatedEvent) => void;
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
  readonly recordAgentContent: (event: AgentContentEvent) => void;
  readonly removeDraftImage: (name: string) => void;
  readonly removeDraftResource: (name: string) => void;
  readonly resolveSessionElicitation: (
    event: SessionElicitationResolvedEvent,
  ) => void;
  readonly resolveSessionPermission: (
    interactionId: string,
    sessionId: string,
  ) => void;
  readonly requestStop: (turn: PendingTurn) => void;
  readonly reportHistorySyncFailure: (message: string) => void;
  readonly runtime: RuntimeConnectionState;
  readonly selectConversation: (conversationId: string) => void;
  readonly selectAgent: (agentId: string) => void;
  readonly selectPrimaryDirectory: (directory: WorkspaceEntry) => void;
  readonly setDraft: (draft: string) => void;
  readonly setErrorMessage: (message: string) => void;
  readonly setRuntime: (runtime: RuntimeConnectionState) => void;
  readonly setSessionPreparationFailed: (
    sessionId: string,
    agentId: string,
    directoryId: string,
    additionalDirectoryIds: readonly string[],
    message: string,
  ) => void;
  readonly setSessionPreparing: (sessionId: string) => void;
  readonly setSidebarOpen: (open: boolean) => void;
  readonly sidebarOpen: boolean;
  readonly startAgentTurn: (turn: PendingTurn, attemptId: string) => void;
  readonly toggleAdditionalDirectory: (directory: WorkspaceEntry) => void;
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

function findConversationBySession(
  conversations: readonly Conversation[],
  sessionId: string,
) {
  return conversations.find(
    (conversation) => conversation.sessionId === sessionId,
  );
}

function replaceSessionConversation(
  conversations: readonly Conversation[],
  sessionId: string,
  update: (conversation: Conversation) => Conversation,
): readonly Conversation[] {
  const conversation = findConversationBySession(conversations, sessionId);
  if (conversation === undefined) {
    return conversations;
  }
  return replaceConversation(conversations, update(conversation));
}

function readAgentMessageByCommand(
  conversation: Conversation,
  commandId: string,
) {
  return conversation.messages.find(
    (message) =>
      message instanceof AgentChatMessage && message.commandId === commandId,
  );
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
  const restoredSessionIds = new Set<string>();
  const conversations: Conversation[] = [];

  for (const session of history.sessions) {
    const turns = history.turns.filter(
      (turn) => turn.sessionId === session.sessionId,
    );
    try {
      conversations.push(
        Conversation.restoreWithSession(
          readAgent(agents, session.agentId),
          session,
          turns,
        ),
      );
      restoredSessionIds.add(session.sessionId);
    } catch {}
  }

  for (const turn of history.turns) {
    if (
      !restoredSessionIds.has(turn.sessionId) &&
      !sessionIds.includes(turn.sessionId)
    ) {
      sessionIds.push(turn.sessionId);
    }
  }

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
  const sessionsById = new Map(
    history.sessions.map((session) => [session.sessionId, session]),
  );
  const existingSessionIds = new Set(
    conversations.map((conversation) => conversation.sessionId),
  );
  const discovered: Conversation[] = [];
  for (const session of history.sessions) {
    if (existingSessionIds.has(session.sessionId)) {
      continue;
    }
    try {
      discovered.push(
        Conversation.restoreWithSession(
          readAgent(agents, session.agentId),
          session,
          turnsBySession.get(session.sessionId) ?? [],
        ),
      );
      existingSessionIds.add(session.sessionId);
    } catch {}
  }
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
    const recordedSession = sessionsById.get(conversation.sessionId);
    const withSession =
      recordedSession === undefined ||
      !conversation.matchesPreparation(
        recordedSession.agentId,
        recordedSession.sessionId,
        recordedSession.directoryId,
        recordedSession.additionalDirectories.map(
          (directory) => directory.directoryId,
        ),
      )
        ? conversation
        : conversation.reconcileRecordedSession(recordedSession);
    const turns = turnsBySession.get(conversation.sessionId);
    if (turns === undefined) {
      return withSession;
    }
    const firstTurn = turns[0];
    if (firstTurn === undefined) {
      return conversation;
    }
    try {
      return withSession.reconcileRecordedTurns(
        readAgent(agents, firstTurn.agentId),
        turns,
      );
    } catch {
      return withSession;
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
  addDraftImage: (image) => {
    set((state) => {
      const conversation = readActiveConversation(state);
      return {
        conversations: replaceConversation(
          state.conversations,
          conversation.addDraftImage(image),
        ),
      };
    });
  },
  addDraftResource: (resource) => {
    set((state) => {
      const conversation = readActiveConversation(state);
      return {
        conversations: replaceConversation(
          state.conversations,
          conversation.addDraftResource(resource),
        ),
      };
    });
  },
  agents: [defaultAgent],
  announcement: "",
  applySessionCommands: (event) => {
    set((state) => ({
      conversations: replaceSessionConversation(
        state.conversations,
        event.sessionId,
        (conversation) =>
          conversation.session instanceof ReadySessionState
            ? conversation.withSession(
                conversation.session.withCommands(event.commands),
              )
            : conversation,
      ),
    }));
  },
  applySessionConfig: (event) => {
    set((state) => ({
      conversations: replaceSessionConversation(
        state.conversations,
        event.sessionId,
        (conversation) =>
          conversation.session instanceof ReadySessionState
            ? conversation.withSession(
                conversation.session.withConfig(event.configOptions),
              )
            : conversation,
      ),
    }));
  },
  applySessionElicitation: (event) => {
    set((state) => ({
      announcement: "The agent needs more information.",
      conversations: replaceSessionConversation(
        state.conversations,
        event.sessionId,
        (conversation) =>
          conversation.session instanceof ReadySessionState
            ? conversation.withSession(
                conversation.session.withElicitation(event),
              )
            : conversation,
      ),
    }));
  },
  applySessionInfo: (event) => {
    set((state) => ({
      conversations: replaceSessionConversation(
        state.conversations,
        event.sessionId,
        (conversation) => {
          const titled = conversation.updateTitle(event.title);
          return titled.session instanceof ReadySessionState
            ? titled.withSession(titled.session.withUpdatedAt(event.updatedAt))
            : titled;
        },
      ),
    }));
  },
  applySessionPermission: (event) => {
    set((state) => ({
      announcement: "The agent is waiting for permission.",
      conversations: replaceSessionConversation(
        state.conversations,
        event.sessionId,
        (conversation) =>
          conversation.session instanceof ReadySessionState
            ? conversation.withSession(
                conversation.session.withPermission(event),
              )
            : conversation,
      ),
    }));
  },
  applySessionReady: (event) => {
    set((state) => {
      const matchesSelection = state.conversations.some((conversation) =>
        conversation.matchesPreparation(
          event.agentId,
          event.sessionId,
          event.directoryId,
          event.additionalDirectories.map((directory) => directory.directoryId),
        ),
      );
      if (!matchesSelection) {
        return {};
      }
      return {
        conversations: replaceSessionConversation(
          state.conversations,
          event.sessionId,
          (conversation) => conversation.applyReady(event),
        ),
        errorMessage: "",
      };
    });
  },
  applySessionUsage: (event) => {
    set((state) => ({
      conversations: replaceSessionConversation(
        state.conversations,
        event.sessionId,
        (conversation) =>
          conversation.session instanceof ReadySessionState
            ? conversation.withSession(conversation.session.withUsage(event))
            : conversation,
      ),
    }));
  },
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
    const userMessage = UserChatMessage.create(
      commandId,
      prompt,
      conversation.draftImages,
      conversation.draftResources,
    );
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
  recordAgentContent: (event) => {
    set((state) => {
      const conversation = findConversationBySession(
        state.conversations,
        event.sessionId,
      );
      if (conversation === undefined) {
        return {};
      }
      const message = readAgentMessageByCommand(conversation, event.commandId);
      if (!(message instanceof AgentChatMessage)) {
        return {};
      }
      return {
        conversations: replaceConversation(
          state.conversations,
          conversation.replaceAgentMessage(
            message.id,
            message.recordContent(event),
          ),
        ),
      };
    });
  },
  removeDraftImage: (name) => {
    set((state) => {
      const conversation = readActiveConversation(state);
      return {
        conversations: replaceConversation(
          state.conversations,
          conversation.removeDraftImage(name),
        ),
      };
    });
  },
  removeDraftResource: (name) => {
    set((state) => {
      const conversation = readActiveConversation(state);
      return {
        conversations: replaceConversation(
          state.conversations,
          conversation.removeDraftResource(name),
        ),
      };
    });
  },
  resolveSessionElicitation: (event) => {
    set((state) => ({
      conversations: replaceSessionConversation(
        state.conversations,
        event.sessionId,
        (conversation) =>
          conversation.session instanceof ReadySessionState
            ? conversation.withSession(
                conversation.session.resolveElicitation(event),
              )
            : conversation,
      ),
    }));
  },
  resolveSessionPermission: (interactionId, sessionId) => {
    set((state) => ({
      conversations: replaceSessionConversation(
        state.conversations,
        sessionId,
        (conversation) =>
          conversation.session instanceof ReadySessionState
            ? conversation.withSession(
                conversation.session.withoutPermission(interactionId),
              )
            : conversation,
      ),
    }));
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
  selectPrimaryDirectory: (directory) => {
    set((state) => {
      const conversation = readActiveConversation(state);
      return {
        conversations: replaceConversation(
          state.conversations,
          conversation.selectPrimaryDirectory(directory),
        ),
      };
    });
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
  setSessionPreparationFailed: (
    sessionId,
    agentId,
    directoryId,
    additionalDirectoryIds,
    message,
  ) => {
    set((state) => {
      const matchesSelection = state.conversations.some((conversation) =>
        conversation.matchesPreparation(
          agentId,
          sessionId,
          directoryId,
          additionalDirectoryIds,
        ),
      );
      if (!matchesSelection) {
        return {};
      }
      return {
        conversations: replaceSessionConversation(
          state.conversations,
          sessionId,
          (conversation) => conversation.markSessionFailed(message),
        ),
        errorMessage: message,
      };
    });
  },
  setSessionPreparing: (sessionId) => {
    set((state) => ({
      conversations: replaceSessionConversation(
        state.conversations,
        sessionId,
        (conversation) => conversation.markSessionPreparing(),
      ),
    }));
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
  toggleAdditionalDirectory: (directory) => {
    set((state) => {
      const conversation = readActiveConversation(state);
      return {
        conversations: replaceConversation(
          state.conversations,
          conversation.toggleAdditionalDirectory(directory),
        ),
      };
    });
  },
  workspaceName: "Local workspace",
}));
