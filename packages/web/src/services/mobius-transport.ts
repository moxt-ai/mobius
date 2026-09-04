import {
  type CancelRequest,
  connectMobiusClient,
  type ElicitationResponseRequest,
  type MobiusClient,
  MobiusClientError,
  type PermissionResponseRequest,
  type PromptRequest,
  type PromptResult,
  type SessionConfigOption,
  type SessionConfigureRequest,
  type SessionPrepareRequest,
  type SessionReadyEvent,
  type WorkspaceEntriesEvent,
  type WorkspaceListRequest,
} from "@moxt-ai/mobius-web-sdk";

import { type ChannelConnection, RecordedActivity } from "@/domain/channel";
import {
  OfflineRuntimeState,
  OnlineRuntimeState,
  UnavailableRuntimeState,
} from "@/domain/chat";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

function createRelayUrl(connection: ChannelConnection): string {
  const relayUrl = new URL(window.location.origin);
  relayUrl.pathname = `/v1/channels/${encodeURIComponent(connection.channelId)}/host`;
  relayUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return relayUrl.toString();
}

function failureMessage(error: unknown): string {
  if (error instanceof MobiusClientError) {
    return `${error.code}: ${error.message}`;
  }
  return "unexpected_error: The request failed unexpectedly";
}

abstract class TransportConnection {
  abstract readonly cancel: (request: CancelRequest) => Promise<void>;
  abstract readonly close: () => Promise<void>;
  abstract readonly configure: (
    request: SessionConfigureRequest,
  ) => Promise<void>;
  abstract readonly elicit: (
    request: ElicitationResponseRequest,
  ) => Promise<void>;
  abstract readonly listWorkspace: (
    request: WorkspaceListRequest,
  ) => Promise<WorkspaceEntriesEvent>;
  abstract readonly permission: (
    request: PermissionResponseRequest,
  ) => Promise<void>;
  abstract readonly prepare: (
    request: SessionPrepareRequest,
  ) => Promise<SessionReadyEvent>;
  abstract readonly prompt: (request: PromptRequest) => Promise<PromptResult>;
}

class DisconnectedTransport extends TransportConnection {
  readonly cancel = (): Promise<void> =>
    Promise.reject(
      new MobiusClientError(
        "transport_not_initialized",
        "The channel transport is not initialized",
      ),
    );

  readonly close = (): Promise<void> => Promise.resolve();

  readonly configure = (): Promise<void> => this.notInitialized();

  readonly elicit = (): Promise<void> => this.notInitialized();

  readonly listWorkspace = (): Promise<WorkspaceEntriesEvent> =>
    this.notInitialized();

  readonly permission = (): Promise<void> => this.notInitialized();

  readonly prepare = (): Promise<SessionReadyEvent> => this.notInitialized();

  readonly prompt = (): Promise<PromptResult> => this.notInitialized();

  private readonly notInitialized = <T>(): Promise<T> =>
    Promise.reject(
      new MobiusClientError(
        "transport_not_initialized",
        "The channel transport is not initialized",
      ),
    );
}

class ConnectedTransport extends TransportConnection {
  readonly #client: Promise<MobiusClient>;

  constructor(connection: ChannelConnection, onActivity: () => void) {
    super();
    this.#client = connectMobiusClient({
      onActivity,
      onCommands: (event) => {
        useChatStore.getState().applySessionCommands(event);
      },
      onConfig: (event) => {
        useChatStore.getState().applySessionConfig(event);
      },
      onContent: (event) => {
        useChatStore.getState().recordAgentContent(event);
      },
      onElicitation: (event) => {
        useChatStore.getState().applySessionElicitation(event);
      },
      onElicitationResolved: (event) => {
        useChatStore.getState().resolveSessionElicitation(event);
      },
      onInfo: (event) => {
        useChatStore.getState().applySessionInfo(event);
      },
      onPermission: (event) => {
        useChatStore.getState().applySessionPermission(event);
      },
      onPermissionResolved: (event) => {
        useChatStore
          .getState()
          .resolveSessionPermission(event.interactionId, event.sessionId);
      },
      onProtocolError: (error) => {
        useChatStore
          .getState()
          .setErrorMessage(`${error.code}: ${error.message}`);
      },
      onStatus: (online) => {
        useChatStore
          .getState()
          .setRuntime(
            online ? new OnlineRuntimeState() : new OfflineRuntimeState(),
          );
      },
      onReady: (event) => {
        useChatStore.getState().applySessionReady(event);
      },
      onUsage: (event) => {
        useChatStore.getState().applySessionUsage(event);
      },
      relayUrl: createRelayUrl(connection),
    });

    void this.#client.catch((error: unknown) => {
      const store = useChatStore.getState();
      store.setRuntime(new UnavailableRuntimeState());
      store.setErrorMessage(failureMessage(error));
    });
  }

  readonly close = async (): Promise<void> => {
    try {
      const client = await this.#client;
      client.close();
    } catch {
      return;
    }
  };

  readonly cancel = async (request: CancelRequest): Promise<void> => {
    const client = await this.#client;
    client.cancel(request);
  };

  readonly configure = async (
    request: SessionConfigureRequest,
  ): Promise<void> => {
    const client = await this.#client;
    await client.configureSession(request);
  };

  readonly elicit = async (
    request: ElicitationResponseRequest,
  ): Promise<void> => {
    const client = await this.#client;
    await client.respondElicitation(request);
  };

  readonly listWorkspace = async (
    request: WorkspaceListRequest,
  ): Promise<WorkspaceEntriesEvent> => {
    const client = await this.#client;
    return await client.listWorkspace(request);
  };

  readonly permission = async (
    request: PermissionResponseRequest,
  ): Promise<void> => {
    const client = await this.#client;
    await client.respondPermission(request);
  };

  readonly prepare = async (
    request: SessionPrepareRequest,
  ): Promise<SessionReadyEvent> => {
    const client = await this.#client;
    return await client.prepareSession(request);
  };

  readonly prompt = async (request: PromptRequest): Promise<PromptResult> => {
    const client = await this.#client;
    return await client.prompt(request);
  };
}

let transport: TransportConnection = new DisconnectedTransport();

export function initializeMobiusTransport(
  connection: ChannelConnection,
  onActivity: () => void,
): void {
  void transport.close();
  transport = new ConnectedTransport(connection, onActivity);
}

export async function prepareActiveSession(
  expectedSessionId = "",
): Promise<void> {
  const initialStore = useChatStore.getState();
  const conversation = selectActiveConversation(initialStore);
  if (
    (expectedSessionId.length > 0 &&
      conversation.sessionId !== expectedSessionId) ||
    !initialStore.runtime.canSend ||
    conversation.session.isReady ||
    conversation.session.isPreparing
  ) {
    return;
  }
  initialStore.setSessionPreparing(conversation.sessionId);
  try {
    const ready = await transport.prepare({
      additionalDirectoryIds: conversation.additionalDirectories.map(
        (directory) => directory.directoryId,
      ),
      agentId: conversation.agentId,
      bindingId: "workspace",
      directoryId: conversation.directoryId,
      sessionId: conversation.sessionId,
    });
    useChatStore.getState().applySessionReady(ready);
  } catch (error) {
    useChatStore.getState().setSessionPreparationFailed(
      conversation.sessionId,
      conversation.agentId,
      conversation.directoryId,
      conversation.additionalDirectories.map(
        (directory) => directory.directoryId,
      ),
      failureMessage(error),
    );
  }
}

export async function listWorkspace(
  directoryId: string,
): Promise<WorkspaceEntriesEvent> {
  return await transport.listWorkspace({
    bindingId: "workspace",
    directoryId,
  });
}

export async function configureSessionOption(
  expectedAgentId: string,
  expectedSessionId: string,
  expectedDirectoryId: string,
  expectedAdditionalDirectoryIds: readonly string[],
  option: SessionConfigOption,
  value: string,
  booleanValue: boolean,
): Promise<void> {
  const store = useChatStore.getState();
  const conversation = selectActiveConversation(store);
  if (
    !store.runtime.canSend ||
    !conversation.session.isReady ||
    !conversation.matchesPreparation(
      expectedAgentId,
      expectedSessionId,
      expectedDirectoryId,
      expectedAdditionalDirectoryIds,
    )
  ) {
    return;
  }
  const currentOption = conversation.session.configOptions.find(
    (candidate) => candidate.id === option.id,
  );
  if (currentOption === undefined || currentOption.type !== option.type) {
    return;
  }
  if (
    currentOption.type === "select" &&
    (currentOption.currentValue === value ||
      !currentOption.values.some((candidate) => candidate.value === value))
  ) {
    return;
  }
  if (
    currentOption.type === "boolean" &&
    currentOption.booleanValue === booleanValue
  ) {
    return;
  }
  try {
    await transport.configure({
      additionalDirectoryIds: conversation.additionalDirectories.map(
        (directory) => directory.directoryId,
      ),
      agentId: conversation.agentId,
      bindingId: "workspace",
      booleanValue,
      configId: currentOption.id,
      directoryId: conversation.directoryId,
      sessionId: conversation.sessionId,
      value,
      valueType: currentOption.type,
    });
    const latestStore = useChatStore.getState();
    if (
      selectActiveConversation(latestStore).matchesPreparation(
        expectedAgentId,
        expectedSessionId,
        expectedDirectoryId,
        expectedAdditionalDirectoryIds,
      )
    ) {
      latestStore.setErrorMessage("");
    }
  } catch (error) {
    const latestStore = useChatStore.getState();
    if (
      selectActiveConversation(latestStore).matchesPreparation(
        expectedAgentId,
        expectedSessionId,
        expectedDirectoryId,
        expectedAdditionalDirectoryIds,
      )
    ) {
      latestStore.setErrorMessage(failureMessage(error));
    }
  }
}

export async function respondToPermission(
  request: PermissionResponseRequest,
): Promise<void> {
  try {
    await transport.permission(request);
    useChatStore.getState().setErrorMessage("");
  } catch (error) {
    useChatStore.getState().setErrorMessage(failureMessage(error));
  }
}

export async function respondToElicitation(
  request: ElicitationResponseRequest,
): Promise<void> {
  try {
    await transport.elicit(request);
    useChatStore.getState().setErrorMessage("");
  } catch (error) {
    useChatStore.getState().setErrorMessage(failureMessage(error));
  }
}

export async function sendPrompt(prompt: string): Promise<void> {
  const normalizedPrompt = prompt.trim();
  await prepareActiveSession();
  const initialStore = useChatStore.getState();
  const conversation = selectActiveConversation(initialStore);
  const hasAttachments =
    conversation.draftImages.length > 0 ||
    conversation.draftResources.length > 0;
  if (
    (normalizedPrompt.length === 0 && !hasAttachments) ||
    conversation.isRunning ||
    !initialStore.runtime.canSend ||
    !conversation.session.isReady
  ) {
    return;
  }

  const turn = initialStore.beginTurn(normalizedPrompt);
  let attemptId = "Pending";

  try {
    const result = await transport.prompt({
      additionalDirectoryIds: conversation.additionalDirectories.map(
        (directory) => directory.directoryId,
      ),
      agentId: turn.agentId,
      bindingId: "workspace",
      commandId: turn.commandId,
      directoryId: conversation.directoryId,
      images: conversation.draftImages,
      observer: {
        onActivity: (activity) => {
          useChatStore
            .getState()
            .recordAgentActivity(
              turn,
              new RecordedActivity(
                activity.activityId,
                activity.activityType,
                activity.input,
                activity.locations,
                activity.name,
                activity.output,
                activity.sequence,
                activity.status,
                activity.title,
                activity.toolKind,
                activity.content,
              ),
            );
        },
        onDelta: (text) => {
          useChatStore.getState().appendAgentText(turn, text);
        },
        onStarted: (processAttemptId) => {
          attemptId = processAttemptId;
          useChatStore.getState().startAgentTurn(turn, processAttemptId);
        },
      },
      prompt: normalizedPrompt,
      resources: conversation.draftResources,
      sessionId: turn.sessionId,
    });
    useChatStore.getState().completeTurn(turn, attemptId, result.stopReason);
  } catch (error) {
    useChatStore.getState().failTurn(turn, failureMessage(error));
  }
}

export async function stopActiveTurn(): Promise<void> {
  const initialStore = useChatStore.getState();
  const conversation = selectActiveConversation(initialStore);
  if (!conversation.canStop) {
    return;
  }
  const turn = conversation.runningTurn();

  try {
    await transport.cancel({
      commandId: turn.commandId,
      sessionId: turn.sessionId,
    });
    useChatStore.getState().requestStop(turn);
    useChatStore.getState().setErrorMessage("");
  } catch (error) {
    useChatStore.getState().setErrorMessage(failureMessage(error));
  }
}

export async function closeMobiusTransport(): Promise<void> {
  const previous = transport;
  transport = new DisconnectedTransport();
  await previous.close();
}
