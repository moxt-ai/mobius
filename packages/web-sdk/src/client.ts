import {
  AGENT_ACTIVITY_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  type AgentActivityEvent,
  decodeAgentActivityEvent,
  decodeAgentMessageDeltaEvent,
  decodeMessageKind,
  decodeRuntimeStatusEvent,
  decodeSessionCancelCommand,
  decodeSessionCompletedEvent,
  decodeSessionFailedEvent,
  decodeSessionPromptCommand,
  decodeSessionStartedEvent,
  encodeSessionCancelCommand,
  encodeSessionPromptCommand,
  MOBIUS_PROTOCOL_VERSION,
  RUNTIME_STATUS_KIND,
  SESSION_CANCEL_KIND,
  SESSION_COMPLETED_KIND,
  SESSION_FAILED_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
} from "@moxt-ai/mobius-protocol";

const CONNECTION_TIMEOUT_MILLISECONDS = 15_000;

export interface ConnectMobiusClientOptions {
  readonly onActivity?: () => void;
  readonly onProtocolError?: (error: MobiusClientError) => void;
  readonly onStatus?: (online: boolean) => void;
  readonly relayUrl: string;
}

export interface PromptObserver {
  readonly onActivity?: (activity: AgentActivityEvent) => void;
  readonly onDelta?: (text: string) => void;
  readonly onStarted?: (processAttemptId: string) => void;
}

export interface CancelRequest {
  readonly commandId: string;
  readonly sessionId: string;
}

export interface PromptRequest {
  readonly agentId: string;
  readonly bindingId: string;
  readonly commandId?: string;
  readonly observer?: PromptObserver;
  readonly prompt: string;
  readonly sessionId?: string;
}

export interface PromptResult {
  readonly sessionId: string;
  readonly stopReason: string;
}

export class MobiusClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.name = "MobiusClientError";
  }
}

function readMessageText(event: MessageEvent<unknown>): string {
  if (typeof event.data !== "string") {
    throw new MobiusClientError(
      "invalid_protocol_message",
      "Relay sent a non-text WebSocket message",
    );
  }

  return event.data;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(
        new MobiusClientError(
          "connection_timeout",
          "Timed out while connecting to the relay",
        ),
      );
    }, CONNECTION_TIMEOUT_MILLISECONDS);

    const cleanup = (): void => {
      window.clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
    };

    const handleOpen = (): void => {
      cleanup();
      resolve();
    };

    const handleError = (): void => {
      cleanup();
      reject(
        new MobiusClientError(
          "connection_failed",
          "Could not connect to the relay",
        ),
      );
    };

    const handleClose = (): void => {
      cleanup();
      reject(
        new MobiusClientError(
          "connection_closed",
          "Relay connection closed before it was ready",
        ),
      );
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
    socket.addEventListener("close", handleClose);
  });
}

export class MobiusClient {
  readonly #onActivity: () => void;
  readonly #onProtocolError: (error: MobiusClientError) => void;
  readonly #onStatus: (online: boolean) => void;
  readonly #socket: WebSocket;

  constructor(socket: WebSocket, options: ConnectMobiusClientOptions) {
    this.#onActivity = options.onActivity ?? (() => undefined);
    this.#onProtocolError = options.onProtocolError ?? (() => undefined);
    this.#onStatus = options.onStatus ?? (() => undefined);
    this.#socket = socket;
    this.#socket.addEventListener("message", this.#handleChannelMessage);
    this.#socket.addEventListener("close", this.#handleClose);
  }

  readonly ready = async (): Promise<void> => {
    await waitForOpen(this.#socket);
  };

  readonly cancel = (request: CancelRequest): void => {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new MobiusClientError(
        "runtime_offline",
        "The relay connection is not open",
      );
    }
    try {
      this.#socket.send(
        encodeSessionCancelCommand({
          commandId: request.commandId,
          kind: SESSION_CANCEL_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId: request.sessionId,
        }),
      );
    } catch (error) {
      throw new MobiusClientError(
        "connection_closed",
        "Could not send cancellation to the relay",
        { cause: error },
      );
    }
  };

  readonly prompt = async (request: PromptRequest): Promise<PromptResult> => {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new MobiusClientError(
        "runtime_offline",
        "The relay connection is not open",
      );
    }

    const commandId = request.commandId ?? crypto.randomUUID();
    const sessionId = request.sessionId ?? crypto.randomUUID();
    let cleanupPrompt = (): void => undefined;

    const result = new Promise<PromptResult>((resolve, reject) => {
      const cleanup = (): void => {
        this.#socket.removeEventListener("message", handleMessage);
        this.#socket.removeEventListener("close", handleSocketClose);
      };
      cleanupPrompt = cleanup;

      const handleSocketClose = (): void => {
        cleanup();
        reject(
          new MobiusClientError(
            "connection_closed",
            "Relay connection closed while the request was running",
          ),
        );
      };

      const handleMessage = (event: MessageEvent<unknown>): void => {
        try {
          const encoded = readMessageText(event);
          const kind = decodeMessageKind(encoded);

          if (kind === SESSION_STARTED_KIND) {
            const message = decodeSessionStartedEvent(encoded);
            if (message.commandId === commandId) {
              request.observer?.onStarted?.(message.processAttemptId);
            }
            return;
          }

          if (kind === AGENT_MESSAGE_DELTA_KIND) {
            const message = decodeAgentMessageDeltaEvent(encoded);
            if (message.commandId === commandId) {
              request.observer?.onDelta?.(message.text);
            }
            return;
          }

          if (kind === AGENT_ACTIVITY_KIND) {
            const message = decodeAgentActivityEvent(encoded);
            if (message.commandId === commandId) {
              request.observer?.onActivity?.(message);
            }
            return;
          }

          if (kind === SESSION_COMPLETED_KIND) {
            const message = decodeSessionCompletedEvent(encoded);
            if (message.commandId === commandId) {
              cleanup();
              resolve({
                sessionId: message.sessionId,
                stopReason: message.stopReason,
              });
            }
            return;
          }

          if (kind === SESSION_FAILED_KIND) {
            const message = decodeSessionFailedEvent(encoded);
            if (message.commandId === commandId) {
              cleanup();
              reject(new MobiusClientError(message.code, message.message));
            }
          }
        } catch (error) {
          cleanup();
          reject(
            new MobiusClientError(
              "invalid_protocol_message",
              "Received an invalid message from the relay",
              { cause: error },
            ),
          );
        }
      };

      this.#socket.addEventListener("message", handleMessage);
      this.#socket.addEventListener("close", handleSocketClose, { once: true });
    });

    try {
      this.#socket.send(
        encodeSessionPromptCommand({
          agentId: request.agentId,
          bindingId: request.bindingId,
          commandId,
          kind: "session.prompt",
          prompt: request.prompt,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId,
        }),
      );
    } catch (error) {
      cleanupPrompt();
      throw new MobiusClientError(
        "connection_closed",
        "Could not send the request to the relay",
        { cause: error },
      );
    }

    return result;
  };

  readonly close = (): void => {
    this.#socket.removeEventListener("message", this.#handleChannelMessage);
    this.#socket.removeEventListener("close", this.#handleClose);
    this.#socket.close(1000, "Host closed");
  };

  readonly #handleClose = (): void => {
    this.#onStatus(false);
  };

  readonly #handleChannelMessage = (event: MessageEvent<unknown>): void => {
    try {
      const encoded = readMessageText(event);
      const kind = decodeMessageKind(encoded);
      if (kind === RUNTIME_STATUS_KIND) {
        this.#onStatus(decodeRuntimeStatusEvent(encoded).online);
        return;
      }
      if (kind === SESSION_PROMPT_KIND) {
        decodeSessionPromptCommand(encoded);
      } else if (kind === SESSION_CANCEL_KIND) {
        decodeSessionCancelCommand(encoded);
      } else if (kind === SESSION_STARTED_KIND) {
        decodeSessionStartedEvent(encoded);
      } else if (kind === AGENT_MESSAGE_DELTA_KIND) {
        decodeAgentMessageDeltaEvent(encoded);
      } else if (kind === AGENT_ACTIVITY_KIND) {
        decodeAgentActivityEvent(encoded);
      } else if (kind === SESSION_COMPLETED_KIND) {
        decodeSessionCompletedEvent(encoded);
      } else if (kind === SESSION_FAILED_KIND) {
        decodeSessionFailedEvent(encoded);
      } else {
        throw new MobiusClientError(
          "invalid_protocol_message",
          "Relay sent an unsupported message kind",
        );
      }
      this.#onActivity();
    } catch (error) {
      this.#onProtocolError(
        new MobiusClientError(
          "invalid_protocol_message",
          "Received an invalid message from the relay",
          { cause: error },
        ),
      );
    }
  };
}

export async function connectMobiusClient(
  options: ConnectMobiusClientOptions,
): Promise<MobiusClient> {
  const socket = new WebSocket(options.relayUrl);
  const client = new MobiusClient(socket, options);

  try {
    await client.ready();
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
