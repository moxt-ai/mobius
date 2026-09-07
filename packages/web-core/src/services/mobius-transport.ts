import {
  type AgentInstallCancelRequest,
  type AgentInstallRequest,
  type CancelRequest,
  connectMobiusClient,
  type ElicitationResponseRequest,
  type MobiusClient,
  MobiusClientError,
  mobiusApiUrl,
  type NativeSessionCommand,
  type NativeSessionResult,
  type PermissionResponseRequest,
  type PromptRequest,
  type PromptResult,
  type SessionConfigOption,
  type SessionConfigUpdatedEvent,
  type SessionConfigureRequest,
  type SessionPrepareRequest,
  type SessionReadyEvent,
  type WorkspaceEntriesEvent,
  type WorkspaceListRequest,
} from "@moxt-ai/mobius-web-sdk";
import {
  type ChannelConnection,
  RecordedActivity,
  RequestedAgentInstallationState,
} from "@/domain/channel";
import {
  DeletedSessionState,
  OfflineRuntimeState,
  OnlineRuntimeState,
  UnavailableRuntimeState,
} from "@/domain/chat";
import { readChannelConnection } from "@/services/pairing-api";
import { isModelConfigurationOption } from "@/services/session-config-presentation";
import {
  readSessionModelPreferences,
  saveSessionModelPreferences,
} from "@/services/session-model-preferences";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

function createRelayUrl(connection: ChannelConnection): string {
  const relayUrl = mobiusApiUrl(
    window.location.origin,
    `/channels/${encodeURIComponent(connection.channelId)}/host`,
  );
  relayUrl.searchParams.set("token", connection.hostToken);
  relayUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return relayUrl.toString();
}

function failureMessage(error: unknown): string {
  const failure = boundaryFailure(error);
  return `${failure.code}: ${failure.message}`;
}

function modelConfigurationPriority(category: string): number {
  if (category === "model") {
    return 0;
  }
  if (category === "thought_level") {
    return 1;
  }
  if (category === "model_config") {
    return 2;
  }
  return 3;
}

interface BoundaryFailure {
  readonly code: string;
  readonly message: string;
}

function boundaryFailure(error: unknown): BoundaryFailure {
  return error instanceof MobiusClientError
    ? { code: error.code, message: error.message }
    : {
        code: "unexpected_error",
        message: "The request failed unexpectedly",
      };
}

abstract class TransportConnection {
  abstract readonly nativeSession: (
    command: NativeSessionCommand,
    signal: AbortSignal,
  ) => Promise<NativeSessionResult>;
  abstract readonly cancelAgentInstallation: (
    request: AgentInstallCancelRequest,
  ) => Promise<void>;
  abstract readonly cancel: (request: CancelRequest) => Promise<void>;
  abstract readonly close: () => Promise<void>;
  abstract readonly configure: (
    request: SessionConfigureRequest,
  ) => Promise<SessionConfigUpdatedEvent>;
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
  abstract readonly installAgent: (
    request: AgentInstallRequest,
  ) => Promise<void>;
}

class DisconnectedTransport extends TransportConnection {
  readonly nativeSession = (): Promise<NativeSessionResult> =>
    this.notInitialized();
  readonly cancelAgentInstallation = (): Promise<void> => this.notInitialized();
  readonly cancel = (): Promise<void> =>
    Promise.reject(
      new MobiusClientError(
        "transport_not_initialized",
        "The channel transport is not initialized",
      ),
    );

  readonly close = (): Promise<void> => Promise.resolve();

  readonly configure = (): Promise<SessionConfigUpdatedEvent> =>
    this.notInitialized();

  readonly elicit = (): Promise<void> => this.notInitialized();

  readonly listWorkspace = (): Promise<WorkspaceEntriesEvent> =>
    this.notInitialized();

  readonly installAgent = (): Promise<void> => this.notInitialized();

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
  readonly #channelId: string;
  readonly #client: Promise<MobiusClient>;
  readonly #preparingRequestIds = new Set<string>();

  constructor(connection: ChannelConnection, onActivity: () => void) {
    super();
    this.#channelId = connection.channelId;
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
      onInstallAwaitingApproval: (event) => {
        useChatStore.getState().applyAgentInstallAwaitingApproval(event);
      },
      onInstallCancelled: (event) => {
        useChatStore.getState().applyAgentInstallCancelled(event);
      },
      onInstallCompleted: (event) => {
        useChatStore.getState().applyAgentInstallCompleted(event);
        void this.#refreshAgentCatalog();
      },
      onInstallFailed: (event) => {
        useChatStore.getState().applyAgentInstallFailed(event);
      },
      onInstallProgress: (event) => {
        useChatStore.getState().applyAgentInstallProgress(event);
      },
      onInstallStarted: (event) => {
        useChatStore.getState().applyAgentInstallStarted(event);
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
      onNativeSessionResult: (event) => {
        if (event.action === "delete")
          useChatStore
            .getState()
            .applyNativeSessionDeletion(event.deletedSessionIds);
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
        if (online) {
          void this.#refreshAgentCatalog();
        }
      },
      onReady: (event) => {
        if (!this.#preparingRequestIds.has(event.requestId)) {
          useChatStore.getState().applySessionReady(event);
        }
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

  readonly nativeSession = async (
    command: NativeSessionCommand,
    signal: AbortSignal,
  ): Promise<NativeSessionResult> => {
    signal.throwIfAborted();
    const client = await this.#client;
    signal.throwIfAborted();
    return await client.manageNativeSession(command, signal);
  };

  readonly cancel = async (request: CancelRequest): Promise<void> => {
    const client = await this.#client;
    client.cancel(request);
  };

  readonly cancelAgentInstallation = async (
    request: AgentInstallCancelRequest,
  ): Promise<void> => {
    const client = await this.#client;
    client.cancelAgentInstallation(request);
  };

  readonly configure = async (
    request: SessionConfigureRequest,
  ): Promise<SessionConfigUpdatedEvent> => {
    const client = await this.#client;
    const configured = await client.configureSession(request);
    saveSessionModelPreferences(
      this.#channelId,
      request.agentId,
      configured.configOptions,
    );
    return configured;
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

  readonly installAgent = async (
    request: AgentInstallRequest,
  ): Promise<void> => {
    const client = await this.#client;
    await client.installAgent(request);
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
    const requestId = request.requestId ?? crypto.randomUUID();
    this.#preparingRequestIds.add(requestId);
    try {
      const client = await this.#client;
      const ready = await client.prepareSession({ ...request, requestId });
      if (ready.restored) {
        return ready;
      }
      const preferenceOrder = new Map(
        ready.configOptions.map((option) => [
          option.id,
          modelConfigurationPriority(option.category),
        ]),
      );
      const preferences = readSessionModelPreferences(
        this.#channelId,
        request.agentId,
      ).toSorted(
        (left, right) =>
          (preferenceOrder.get(left.configId) ?? 3) -
          (preferenceOrder.get(right.configId) ?? 3),
      );
      let bindingId = request.bindingId;
      let configOptions = ready.configOptions;
      for (const preference of preferences) {
        const option = configOptions.find(
          (candidate) => candidate.id === preference.configId,
        );
        if (
          option === undefined ||
          option.type !== preference.valueType ||
          !isModelConfigurationOption(option)
        ) {
          continue;
        }
        if (option.type === "select") {
          if (
            option.currentValue === preference.value ||
            !option.values.some(
              (candidate) => candidate.value === preference.value,
            )
          ) {
            continue;
          }
        } else if (option.booleanValue === preference.booleanValue) {
          continue;
        }
        const configured = await client.configureSession({
          ...request,
          bindingId,
          booleanValue: preference.booleanValue,
          configId: option.id,
          value: preference.value,
          valueType: option.type,
        });
        bindingId = configured.requestId;
        configOptions = configured.configOptions;
        saveSessionModelPreferences(
          this.#channelId,
          request.agentId,
          configOptions,
        );
      }
      return configOptions === ready.configOptions
        ? ready
        : { ...ready, configOptions };
    } finally {
      this.#preparingRequestIds.delete(requestId);
    }
  };

  readonly prompt = async (request: PromptRequest): Promise<PromptResult> => {
    const client = await this.#client;
    return await client.prompt(request);
  };

  readonly #refreshAgentCatalog = async (): Promise<void> => {
    try {
      const connection = await readChannelConnection(this.#channelId);
      useChatStore.getState().refreshChannelConnection(connection);
    } catch (error) {
      useChatStore.getState().setErrorMessage(failureMessage(error));
    }
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
    conversation.session instanceof DeletedSessionState ||
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
      bindingId: conversation.bindingId,
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

type NativeSessionAction =
  | { readonly action: "list"; readonly cursor: string | null }
  | {
      readonly action: "fork" | "import";
      readonly directoryId: string;
      readonly entryId: string;
    }
  | {
      readonly action: "delete";
      readonly directoryId: string;
      readonly entryId: string;
    };

export interface NativeSessionScope {
  readonly agentId: string;
  readonly directoryId: string;
  readonly sessionId: string;
}

export async function manageNativeSession(
  scope: NativeSessionScope,
  action: NativeSessionAction,
  signal: AbortSignal,
): Promise<NativeSessionResult> {
  const identity = {
    additionalDirectoryIds: [],
    agentId: scope.agentId,
    bindingId: "workspace",
    directoryId:
      action.action === "list" ? scope.directoryId : action.directoryId,
    sessionId: scope.sessionId,
    requestId: crypto.randomUUID(),
    kind: "native.session.request",
  } satisfies Omit<NativeSessionCommand, "action">;
  switch (action.action) {
    case "import":
    case "fork":
      return await transport.nativeSession(
        { ...identity, ...action, targetSessionId: crypto.randomUUID() },
        signal,
      );
    case "list":
    case "delete":
      return await transport.nativeSession({ ...identity, ...action }, signal);
  }
}

export type SessionConfigurationResult =
  | { readonly kind: "applied" }
  | { readonly kind: "ignored" }
  | {
      readonly code: string;
      readonly kind: "failed";
      readonly message: string;
    };

export async function configureSessionOption(
  expectedAgentId: string,
  expectedSessionId: string,
  expectedDirectoryId: string,
  expectedAdditionalDirectoryIds: readonly string[],
  option: SessionConfigOption,
  value: string,
  booleanValue: boolean,
): Promise<SessionConfigurationResult> {
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
    return { kind: "ignored" };
  }
  const currentOption = conversation.session.configOptions.find(
    (candidate) => candidate.id === option.id,
  );
  if (currentOption === undefined || currentOption.type !== option.type) {
    return { kind: "ignored" };
  }
  if (
    currentOption.type === "select" &&
    (currentOption.currentValue === value ||
      !currentOption.values.some((candidate) => candidate.value === value))
  ) {
    return { kind: "ignored" };
  }
  if (
    currentOption.type === "boolean" &&
    currentOption.booleanValue === booleanValue
  ) {
    return { kind: "ignored" };
  }
  try {
    await transport.configure({
      additionalDirectoryIds: conversation.additionalDirectories.map(
        (directory) => directory.directoryId,
      ),
      agentId: conversation.agentId,
      bindingId: conversation.bindingId,
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
    return { kind: "applied" };
  } catch (error) {
    const failure = boundaryFailure(error);
    const latestStore = useChatStore.getState();
    if (
      selectActiveConversation(latestStore).matchesPreparation(
        expectedAgentId,
        expectedSessionId,
        expectedDirectoryId,
        expectedAdditionalDirectoryIds,
      )
    ) {
      latestStore.setErrorMessage(`${failure.code}: ${failure.message}`);
    }
    return { ...failure, kind: "failed" };
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
      bindingId: conversation.bindingId,
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
                attemptId,
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
                activity.detail.kind === "recorded"
                  ? "inline"
                  : activity.detail.kind,
              ),
            );
        },
        onDelta: (text) => {
          useChatStore.getState().appendAgentText(turn, text);
        },
        onStarted: (startedAttemptId) => {
          attemptId = startedAttemptId;
          useChatStore.getState().startAgentTurn(turn, startedAttemptId);
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

export async function installLocalAgent(agentId: string): Promise<void> {
  const state = useChatStore.getState();
  if (!state.installableAgents.some((agent) => agent.id === agentId)) {
    return;
  }
  const installation = state.agentInstallations.find(
    (candidate) => candidate.agentId === agentId,
  );
  if (installation?.canCancel === true) {
    return;
  }
  const requestId = crypto.randomUUID();
  state.beginAgentInstallation(agentId, requestId);
  try {
    await transport.installAgent({ agentId, requestId });
  } catch (error) {
    const failure =
      error instanceof MobiusClientError
        ? error
        : new MobiusClientError(
            "unexpected_error",
            "The Agent installation failed unexpectedly",
          );
    if (failure.code === "installation_cancelled") {
      return;
    }
    useChatStore.getState().applyAgentInstallFailed({
      agentId,
      code: failure.code,
      kind: "agent.install.failed",
      message: failure.message,
      requestId,
    });
  }
}

export async function cancelLocalAgentInstallation(
  agentId: string,
): Promise<void> {
  const state = useChatStore.getState();
  const installation = state.agentInstallations.find(
    (candidate) => candidate.agentId === agentId,
  );
  if (
    !(installation instanceof RequestedAgentInstallationState) ||
    !installation.canCancel
  ) {
    return;
  }
  try {
    await transport.cancelAgentInstallation({
      requestId: installation.requestId,
    });
  } catch (error) {
    state.setErrorMessage(failureMessage(error));
  }
}

export async function closeMobiusTransport(): Promise<void> {
  const previous = transport;
  transport = new DisconnectedTransport();
  await previous.close();
}
