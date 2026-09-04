import {
  type CancelRequest,
  connectMobiusClient,
  type MobiusClient,
  MobiusClientError,
  type PromptRequest,
  type PromptResult,
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

  readonly prompt = (): Promise<PromptResult> =>
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

export async function sendPrompt(prompt: string): Promise<void> {
  const normalizedPrompt = prompt.trim();
  const initialStore = useChatStore.getState();
  const conversation = selectActiveConversation(initialStore);
  if (
    normalizedPrompt.length === 0 ||
    conversation.isRunning ||
    !initialStore.runtime.canSend
  ) {
    return;
  }

  const turn = initialStore.beginTurn(normalizedPrompt);
  let attemptId = "Pending";

  try {
    const result = await transport.prompt({
      agentId: turn.agentId,
      bindingId: "workspace",
      commandId: turn.commandId,
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
