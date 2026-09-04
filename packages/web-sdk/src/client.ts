import {
  AGENT_ACTIVITY_KIND,
  AGENT_CONTENT_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  type AgentActivityEvent,
  type AgentContentEvent,
  decodeAgentActivityEvent,
  decodeAgentContentEvent,
  decodeAgentMessageDeltaEvent,
  decodeMessageKind,
  decodeRuntimeStatusEvent,
  decodeSessionCancelCommand,
  decodeSessionCommandsUpdatedEvent,
  decodeSessionCompletedEvent,
  decodeSessionConfigUpdatedEvent,
  decodeSessionConfigureCommand,
  decodeSessionElicitationRequestedEvent,
  decodeSessionElicitationResolvedEvent,
  decodeSessionElicitationRespondCommand,
  decodeSessionFailedEvent,
  decodeSessionInfoUpdatedEvent,
  decodeSessionOperationFailedEvent,
  decodeSessionPermissionRequestedEvent,
  decodeSessionPermissionResolvedEvent,
  decodeSessionPermissionRespondCommand,
  decodeSessionPrepareCommand,
  decodeSessionPromptCommand,
  decodeSessionReadyEvent,
  decodeSessionStartedEvent,
  decodeSessionUsageUpdatedEvent,
  decodeWorkspaceEntriesEvent,
  decodeWorkspaceListCommand,
  encodeSessionCancelCommand,
  encodeSessionConfigureCommand,
  encodeSessionElicitationRespondCommand,
  encodeSessionPermissionRespondCommand,
  encodeSessionPrepareCommand,
  encodeSessionPromptCommand,
  encodeWorkspaceListCommand,
  MOBIUS_PROTOCOL_VERSION,
  type PromptImage,
  type PromptResource,
  RUNTIME_STATUS_KIND,
  SESSION_CANCEL_KIND,
  SESSION_COMMANDS_UPDATED_KIND,
  SESSION_COMPLETED_KIND,
  SESSION_CONFIG_UPDATED_KIND,
  SESSION_CONFIGURE_KIND,
  SESSION_ELICITATION_REQUESTED_KIND,
  SESSION_ELICITATION_RESOLVED_KIND,
  SESSION_ELICITATION_RESPOND_KIND,
  SESSION_FAILED_KIND,
  SESSION_INFO_UPDATED_KIND,
  SESSION_OPERATION_FAILED_KIND,
  SESSION_PERMISSION_REQUESTED_KIND,
  SESSION_PERMISSION_RESOLVED_KIND,
  SESSION_PERMISSION_RESPOND_KIND,
  SESSION_PREPARE_KIND,
  SESSION_PROMPT_KIND,
  SESSION_READY_KIND,
  SESSION_STARTED_KIND,
  SESSION_USAGE_UPDATED_KIND,
  type SessionCommandsUpdatedEvent,
  type SessionConfigUpdatedEvent,
  type SessionElicitationRequestedEvent,
  type SessionElicitationResolvedEvent,
  type SessionElicitationRespondCommand,
  type SessionInfoUpdatedEvent,
  type SessionPermissionRequestedEvent,
  type SessionPermissionResolvedEvent,
  type SessionReadyEvent,
  type SessionUsageUpdatedEvent,
  WORKSPACE_ENTRIES_KIND,
  WORKSPACE_LIST_KIND,
  type WorkspaceEntriesEvent,
} from "@moxt-ai/mobius-protocol";

const CONNECTION_TIMEOUT_MILLISECONDS = 15_000;
const OPERATION_TIMEOUT_MILLISECONDS = 120_000;

export interface ConnectMobiusClientOptions {
  readonly onActivity?: () => void;
  readonly onCommands?: (event: SessionCommandsUpdatedEvent) => void;
  readonly onConfig?: (event: SessionConfigUpdatedEvent) => void;
  readonly onContent?: (event: AgentContentEvent) => void;
  readonly onElicitation?: (event: SessionElicitationRequestedEvent) => void;
  readonly onElicitationResolved?: (
    event: SessionElicitationResolvedEvent,
  ) => void;
  readonly onInfo?: (event: SessionInfoUpdatedEvent) => void;
  readonly onPermission?: (event: SessionPermissionRequestedEvent) => void;
  readonly onPermissionResolved?: (
    event: SessionPermissionResolvedEvent,
  ) => void;
  readonly onProtocolError?: (error: MobiusClientError) => void;
  readonly onReady?: (event: SessionReadyEvent) => void;
  readonly onStatus?: (online: boolean) => void;
  readonly onUsage?: (event: SessionUsageUpdatedEvent) => void;
  readonly onWorkspace?: (event: WorkspaceEntriesEvent) => void;
  readonly relayUrl: string;
}

export interface PromptObserver {
  readonly onActivity?: (activity: AgentActivityEvent) => void;
  readonly onContent?: (content: AgentContentEvent) => void;
  readonly onDelta?: (text: string) => void;
  readonly onStarted?: (processAttemptId: string) => void;
}

export interface CancelRequest {
  readonly commandId: string;
  readonly sessionId: string;
}

export interface PromptRequest {
  readonly additionalDirectoryIds?: readonly string[];
  readonly agentId: string;
  readonly bindingId: string;
  readonly commandId?: string;
  readonly directoryId?: string;
  readonly images?: readonly PromptImage[];
  readonly observer?: PromptObserver;
  readonly prompt: string;
  readonly resources?: readonly PromptResource[];
  readonly sessionId?: string;
}

export interface WorkspaceListRequest {
  readonly bindingId: string;
  readonly directoryId: string;
  readonly requestId?: string;
}

export interface SessionPrepareRequest {
  readonly additionalDirectoryIds: readonly string[];
  readonly agentId: string;
  readonly bindingId: string;
  readonly directoryId: string;
  readonly requestId?: string;
  readonly sessionId: string;
}

export interface SessionConfigureRequest extends SessionPrepareRequest {
  readonly booleanValue: boolean;
  readonly configId: string;
  readonly value: string;
  readonly valueType: SessionConfigUpdatedEvent["configOptions"][number]["type"];
}

export interface PermissionResponseRequest {
  readonly interactionId: string;
  readonly optionId: string;
  readonly outcome: SessionPermissionResolvedEvent["outcome"];
  readonly sessionId: string;
}

export interface ElicitationResponseRequest {
  readonly action: SessionElicitationRespondCommand["action"];
  readonly content: string;
  readonly interactionId: string;
  readonly sessionId: string;
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

function encodeOutboundMessage(encode: () => string): string {
  try {
    return encode();
  } catch (error) {
    throw new MobiusClientError(
      "invalid_request",
      "The requested operation contains invalid data",
      { cause: error },
    );
  }
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
  readonly #options: ConnectMobiusClientOptions;
  readonly #socket: WebSocket;

  constructor(socket: WebSocket, options: ConnectMobiusClientOptions) {
    this.#options = options;
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

  readonly listWorkspace = async (
    request: WorkspaceListRequest,
  ): Promise<WorkspaceEntriesEvent> => {
    const requestId = request.requestId ?? crypto.randomUUID();
    return await this.#requestReply(
      requestId,
      encodeOutboundMessage(() =>
        encodeWorkspaceListCommand({
          bindingId: request.bindingId,
          directoryId: request.directoryId,
          kind: WORKSPACE_LIST_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          requestId,
        }),
      ),
      WORKSPACE_ENTRIES_KIND,
      decodeWorkspaceEntriesEvent,
      (event) => event.requestId,
    );
  };

  readonly prepareSession = async (
    request: SessionPrepareRequest,
  ): Promise<SessionReadyEvent> => {
    const requestId = request.requestId ?? crypto.randomUUID();
    return await this.#requestReply(
      requestId,
      encodeOutboundMessage(() =>
        encodeSessionPrepareCommand({
          additionalDirectoryIds: request.additionalDirectoryIds,
          agentId: request.agentId,
          bindingId: request.bindingId,
          directoryId: request.directoryId,
          kind: SESSION_PREPARE_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          requestId,
          sessionId: request.sessionId,
        }),
      ),
      SESSION_READY_KIND,
      decodeSessionReadyEvent,
      (event) => event.requestId,
    );
  };

  readonly configureSession = async (
    request: SessionConfigureRequest,
  ): Promise<SessionConfigUpdatedEvent> => {
    const requestId = request.requestId ?? crypto.randomUUID();
    return await this.#requestReply(
      requestId,
      encodeOutboundMessage(() =>
        encodeSessionConfigureCommand({
          additionalDirectoryIds: request.additionalDirectoryIds,
          agentId: request.agentId,
          bindingId: request.bindingId,
          booleanValue: request.booleanValue,
          configId: request.configId,
          directoryId: request.directoryId,
          kind: SESSION_CONFIGURE_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          requestId,
          sessionId: request.sessionId,
          value: request.value,
          valueType: request.valueType,
        }),
      ),
      SESSION_CONFIG_UPDATED_KIND,
      decodeSessionConfigUpdatedEvent,
      (event) => event.requestId,
    );
  };

  readonly respondPermission = async (
    request: PermissionResponseRequest,
  ): Promise<SessionPermissionResolvedEvent> =>
    await this.#requestReply(
      request.interactionId,
      encodeOutboundMessage(() =>
        encodeSessionPermissionRespondCommand({
          interactionId: request.interactionId,
          kind: SESSION_PERMISSION_RESPOND_KIND,
          optionId: request.optionId,
          outcome: request.outcome,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId: request.sessionId,
        }),
      ),
      SESSION_PERMISSION_RESOLVED_KIND,
      decodeSessionPermissionResolvedEvent,
      (event) => event.interactionId,
    );

  readonly respondElicitation = async (
    request: ElicitationResponseRequest,
  ): Promise<SessionElicitationResolvedEvent> =>
    await this.#requestReply(
      request.interactionId,
      encodeOutboundMessage(() =>
        encodeSessionElicitationRespondCommand({
          action: request.action,
          content: request.content,
          interactionId: request.interactionId,
          kind: SESSION_ELICITATION_RESPOND_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId: request.sessionId,
        }),
      ),
      SESSION_ELICITATION_RESOLVED_KIND,
      decodeSessionElicitationResolvedEvent,
      (event) => event.interactionId,
    );

  readonly cancel = (request: CancelRequest): void => {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new MobiusClientError(
        "runtime_offline",
        "The relay connection is not open",
      );
    }
    try {
      this.#socket.send(
        encodeOutboundMessage(() =>
          encodeSessionCancelCommand({
            commandId: request.commandId,
            kind: SESSION_CANCEL_KIND,
            protocolVersion: MOBIUS_PROTOCOL_VERSION,
            sessionId: request.sessionId,
          }),
        ),
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

          if (kind === AGENT_CONTENT_KIND) {
            const message = decodeAgentContentEvent(encoded);
            if (message.commandId === commandId) {
              request.observer?.onContent?.(message);
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
        encodeOutboundMessage(() =>
          encodeSessionPromptCommand({
            additionalDirectoryIds: request.additionalDirectoryIds ?? [],
            agentId: request.agentId,
            bindingId: request.bindingId,
            commandId,
            directoryId: request.directoryId ?? "root",
            images: request.images ?? [],
            kind: SESSION_PROMPT_KIND,
            prompt: request.prompt,
            protocolVersion: MOBIUS_PROTOCOL_VERSION,
            resources: request.resources ?? [],
            sessionId,
          }),
        ),
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

  readonly #requestReply = async <T>(
    requestId: string,
    outbound: string,
    expectedKind: string,
    decode: (encoded: string) => T,
    identify: (event: T) => string,
  ): Promise<T> => {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new MobiusClientError(
        "runtime_offline",
        "The relay connection is not open",
      );
    }
    let cleanupRequest = (): void => undefined;
    const result = new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(
          new MobiusClientError(
            "operation_timeout",
            "Timed out while waiting for the local runtime",
          ),
        );
      }, OPERATION_TIMEOUT_MILLISECONDS);
      const cleanup = (): void => {
        window.clearTimeout(timeout);
        this.#socket.removeEventListener("message", handleMessage);
        this.#socket.removeEventListener("close", handleClose);
      };
      cleanupRequest = cleanup;
      const handleClose = (): void => {
        cleanup();
        reject(
          new MobiusClientError(
            "connection_closed",
            "Relay connection closed while the operation was running",
          ),
        );
      };
      const handleMessage = (message: MessageEvent<unknown>): void => {
        try {
          const encoded = readMessageText(message);
          const kind = decodeMessageKind(encoded);
          if (kind === SESSION_OPERATION_FAILED_KIND) {
            const failure = decodeSessionOperationFailedEvent(encoded);
            if (failure.requestId === requestId) {
              cleanup();
              reject(new MobiusClientError(failure.code, failure.message));
            }
            return;
          }
          if (kind !== expectedKind) {
            return;
          }
          const event = decode(encoded);
          if (identify(event) === requestId) {
            cleanup();
            resolve(event);
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
      this.#socket.addEventListener("close", handleClose, { once: true });
    });
    try {
      this.#socket.send(outbound);
    } catch (error) {
      cleanupRequest();
      throw new MobiusClientError(
        "connection_closed",
        "Could not send the operation to the relay",
        { cause: error },
      );
    }
    return await result;
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
      } else if (kind === WORKSPACE_LIST_KIND) {
        decodeWorkspaceListCommand(encoded);
      } else if (kind === WORKSPACE_ENTRIES_KIND) {
        this.#options.onWorkspace?.(decodeWorkspaceEntriesEvent(encoded));
      } else if (kind === SESSION_PREPARE_KIND) {
        decodeSessionPrepareCommand(encoded);
      } else if (kind === SESSION_READY_KIND) {
        this.#options.onReady?.(decodeSessionReadyEvent(encoded));
      } else if (kind === SESSION_CONFIGURE_KIND) {
        decodeSessionConfigureCommand(encoded);
      } else if (kind === SESSION_CONFIG_UPDATED_KIND) {
        this.#options.onConfig?.(decodeSessionConfigUpdatedEvent(encoded));
      } else if (kind === SESSION_COMMANDS_UPDATED_KIND) {
        this.#options.onCommands?.(decodeSessionCommandsUpdatedEvent(encoded));
      } else if (kind === SESSION_INFO_UPDATED_KIND) {
        this.#options.onInfo?.(decodeSessionInfoUpdatedEvent(encoded));
      } else if (kind === SESSION_USAGE_UPDATED_KIND) {
        this.#options.onUsage?.(decodeSessionUsageUpdatedEvent(encoded));
      } else if (kind === SESSION_PERMISSION_REQUESTED_KIND) {
        this.#options.onPermission?.(
          decodeSessionPermissionRequestedEvent(encoded),
        );
      } else if (kind === SESSION_PERMISSION_RESPOND_KIND) {
        decodeSessionPermissionRespondCommand(encoded);
      } else if (kind === SESSION_PERMISSION_RESOLVED_KIND) {
        this.#options.onPermissionResolved?.(
          decodeSessionPermissionResolvedEvent(encoded),
        );
      } else if (kind === SESSION_ELICITATION_REQUESTED_KIND) {
        this.#options.onElicitation?.(
          decodeSessionElicitationRequestedEvent(encoded),
        );
      } else if (kind === SESSION_ELICITATION_RESPOND_KIND) {
        decodeSessionElicitationRespondCommand(encoded);
      } else if (kind === SESSION_ELICITATION_RESOLVED_KIND) {
        this.#options.onElicitationResolved?.(
          decodeSessionElicitationResolvedEvent(encoded),
        );
      } else if (kind === SESSION_STARTED_KIND) {
        decodeSessionStartedEvent(encoded);
      } else if (kind === AGENT_MESSAGE_DELTA_KIND) {
        decodeAgentMessageDeltaEvent(encoded);
      } else if (kind === AGENT_ACTIVITY_KIND) {
        decodeAgentActivityEvent(encoded);
      } else if (kind === AGENT_CONTENT_KIND) {
        this.#options.onContent?.(decodeAgentContentEvent(encoded));
      } else if (kind === SESSION_COMPLETED_KIND) {
        decodeSessionCompletedEvent(encoded);
      } else if (kind === SESSION_FAILED_KIND) {
        decodeSessionFailedEvent(encoded);
      } else if (kind === SESSION_OPERATION_FAILED_KIND) {
        decodeSessionOperationFailedEvent(encoded);
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
