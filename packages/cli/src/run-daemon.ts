import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import {
  AGENT_ACTIVITY_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  type AgentContentEvent,
  decodeMessageKind,
  decodeSessionCancelCommand,
  decodeSessionConfigureCommand,
  decodeSessionElicitationRespondCommand,
  decodeSessionPermissionRespondCommand,
  decodeSessionPrepareCommand,
  decodeSessionPromptCommand,
  decodeWorkspaceListCommand,
  encodeAgentActivityEvent,
  encodeAgentContentEvent,
  encodeAgentMessageDeltaEvent,
  encodeSessionCommandsUpdatedEvent,
  encodeSessionCompletedEvent,
  encodeSessionConfigUpdatedEvent,
  encodeSessionElicitationRequestedEvent,
  encodeSessionElicitationResolvedEvent,
  encodeSessionFailedEvent,
  encodeSessionInfoUpdatedEvent,
  encodeSessionOperationFailedEvent,
  encodeSessionPermissionRequestedEvent,
  encodeSessionPermissionResolvedEvent,
  encodeSessionReadyEvent,
  encodeSessionStartedEvent,
  encodeSessionUsageUpdatedEvent,
  encodeWorkspaceEntriesEvent,
  MOBIUS_PROTOCOL_VERSION,
  SESSION_CANCEL_KIND,
  SESSION_COMPLETED_KIND,
  SESSION_CONFIGURE_KIND,
  SESSION_ELICITATION_RESPOND_KIND,
  SESSION_FAILED_KIND,
  SESSION_PERMISSION_RESPOND_KIND,
  SESSION_PREPARE_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
  type SessionCancelCommand,
  type SessionCommandsUpdatedEvent,
  type SessionConfigUpdatedEvent,
  type SessionConfigureCommand,
  type SessionElicitationRequestedEvent,
  type SessionElicitationResolvedEvent,
  type SessionInfoUpdatedEvent,
  type SessionPermissionRequestedEvent,
  type SessionPermissionResolvedEvent,
  type SessionPrepareCommand,
  type SessionPromptCommand,
  type SessionUsageUpdatedEvent,
  WORKSPACE_LIST_KIND,
  type WorkspaceListCommand,
} from "@moxt-ai/mobius-protocol";
import { type MessageEvent, WebSocket } from "undici";

import {
  AcpExecutionError,
  AcpSessionManager,
  type AcpSessionObserver,
  NullAcpSessionObserver,
} from "./acp/session-manager.ts";
import { SqliteAcpSessionStore } from "./acp/session-store.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { LocalAuthorizationError } from "./authorization/authorize-binding.ts";
import { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import { type DaemonConfig, findLocalAgent } from "./config.ts";
import { connectRelay } from "./relay-connection/connect.ts";

const RELAY_RECONNECT_DELAY_MILLISECONDS = 500;

class DaemonAcpObserver implements AcpSessionObserver {
  readonly #socket: WebSocket;

  constructor(socket: WebSocket) {
    this.#socket = socket;
  }

  readonly onCommands = (event: SessionCommandsUpdatedEvent): Promise<void> => {
    send(this.#socket, encodeSessionCommandsUpdatedEvent(event));
    return Promise.resolve();
  };

  readonly onConfig = (event: SessionConfigUpdatedEvent): Promise<void> => {
    send(this.#socket, encodeSessionConfigUpdatedEvent(event));
    return Promise.resolve();
  };

  readonly onContent = (event: AgentContentEvent): Promise<void> => {
    send(this.#socket, encodeAgentContentEvent(event));
    return Promise.resolve();
  };

  readonly onElicitation = (
    event: SessionElicitationRequestedEvent,
  ): Promise<void> => {
    send(this.#socket, encodeSessionElicitationRequestedEvent(event));
    return Promise.resolve();
  };

  readonly onElicitationResolved = (
    event: SessionElicitationResolvedEvent,
  ): Promise<void> => {
    send(this.#socket, encodeSessionElicitationResolvedEvent(event));
    return Promise.resolve();
  };

  readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
    send(this.#socket, encodeSessionInfoUpdatedEvent(event));
    return Promise.resolve();
  };

  readonly onPermission = (
    event: SessionPermissionRequestedEvent,
  ): Promise<void> => {
    send(this.#socket, encodeSessionPermissionRequestedEvent(event));
    return Promise.resolve();
  };

  readonly onPermissionResolved = (
    event: SessionPermissionResolvedEvent,
  ): Promise<void> => {
    send(this.#socket, encodeSessionPermissionResolvedEvent(event));
    return Promise.resolve();
  };

  readonly onUsage = (event: SessionUsageUpdatedEvent): Promise<void> => {
    send(this.#socket, encodeSessionUsageUpdatedEvent(event));
    return Promise.resolve();
  };
}

class ResolvedSessionDirectories {
  readonly additionalDirectories: readonly string[];
  readonly additionalDirectoryEntries: readonly {
    readonly directoryId: string;
    readonly name: string;
  }[];
  readonly cwd: string;

  constructor(
    cwd: string,
    additionalDirectories: readonly string[],
    additionalDirectoryEntries: readonly {
      readonly directoryId: string;
      readonly name: string;
    }[],
  ) {
    this.additionalDirectories = additionalDirectories;
    this.additionalDirectoryEntries = additionalDirectoryEntries;
    this.cwd = cwd;
  }
}

class ActiveDaemonTurn {
  readonly command: SessionPromptCommand;
  readonly #connectionController: AbortController;
  #cancellationRequested = false;

  constructor(
    command: SessionPromptCommand,
    connectionController: AbortController,
  ) {
    this.command = command;
    this.#connectionController = connectionController;
  }

  readonly abortConnection = (): void => {
    this.#connectionController.abort();
  };

  readonly matches = (cancellation: SessionCancelCommand): boolean =>
    cancellation.commandId === this.command.commandId &&
    cancellation.sessionId === this.command.sessionId;

  readonly requestCancellation = (): boolean => {
    if (this.#cancellationRequested) {
      return false;
    }
    this.#cancellationRequested = true;
    return true;
  };

  get signal(): AbortSignal {
    return this.#connectionController.signal;
  }
}

function send(socket: WebSocket, message: string): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("Relay connection is not open");
  }
  socket.send(message);
}

function reportFailure(
  socket: WebSocket,
  command: SessionPromptCommand,
  code: string,
  message: string,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  send(
    socket,
    encodeSessionFailedEvent({
      code,
      commandId: command.commandId,
      kind: SESSION_FAILED_KIND,
      message,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: command.sessionId,
    }),
  );
}

function operationErrorCode(error: unknown): string {
  if (
    error instanceof AcpExecutionError ||
    error instanceof LocalAuthorizationError
  ) {
    return error.code;
  }
  return "session_operation_failed";
}

function operationErrorMessage(error: unknown): string {
  if (
    error instanceof AcpExecutionError ||
    error instanceof LocalAuthorizationError
  ) {
    return error.message;
  }
  return "The local agent operation could not be completed";
}

function reportOperationFailure(
  socket: WebSocket,
  requestId: string,
  sessionId: string,
  error: unknown,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  send(
    socket,
    encodeSessionOperationFailedEvent({
      code: operationErrorCode(error),
      kind: "session.operation.failed",
      message: operationErrorMessage(error),
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId,
      sessionId,
    }),
  );
}

async function resolveSessionDirectories(
  directories: WorkspaceDirectoryService,
  bindingId: string,
  directoryId: string,
  additionalDirectoryIds: readonly string[],
): Promise<ResolvedSessionDirectories> {
  const cwd = await directories.resolve(bindingId, directoryId);
  const additionalDirectories: string[] = [];
  const additionalDirectoryEntries: {
    readonly directoryId: string;
    readonly name: string;
  }[] = [];
  const unique = new Set<string>([cwd]);
  for (const additionalDirectoryId of additionalDirectoryIds) {
    const directory = await directories.resolve(
      bindingId,
      additionalDirectoryId,
    );
    if (unique.has(directory)) {
      throw new LocalAuthorizationError(
        "Workspace directories must resolve to distinct locations",
      );
    }
    unique.add(directory);
    additionalDirectories.push(directory);
    additionalDirectoryEntries.push({
      directoryId: additionalDirectoryId,
      name: basename(directory),
    });
  }
  return new ResolvedSessionDirectories(
    cwd,
    additionalDirectories,
    additionalDirectoryEntries,
  );
}

async function executeWorkspaceList(
  socket: WebSocket,
  command: WorkspaceListCommand,
  directories: WorkspaceDirectoryService,
  audit: AuditStore,
): Promise<void> {
  try {
    const listing = await directories.list(
      command.bindingId,
      command.directoryId,
    );
    audit.record({
      commandId: command.requestId,
      event: "workspace_list_authorized",
      sessionId: "workspace-browser",
    });
    send(
      socket,
      encodeWorkspaceEntriesEvent({
        bindingId: command.bindingId,
        directoryId: listing.directoryId,
        directoryLabel: listing.directoryLabel,
        entries: listing.entries,
        kind: "workspace.entries",
        parentDirectoryId: listing.parentDirectoryId,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        requestId: command.requestId,
      }),
    );
  } catch (error) {
    reportOperationFailure(socket, command.requestId, "", error);
  }
}

async function executeSessionPrepare(
  socket: WebSocket,
  command: SessionPrepareCommand,
  config: DaemonConfig,
  directories: WorkspaceDirectoryService,
  audit: AuditStore,
  sessions: AcpSessionManager,
  signal: AbortSignal,
): Promise<void> {
  try {
    const resolved = await resolveSessionDirectories(
      directories,
      command.bindingId,
      command.directoryId,
      command.additionalDirectoryIds,
    );
    const agent = findLocalAgent(config.agents, command.agentId);
    const prepared = await sessions.prepareSession({
      additionalDirectories: resolved.additionalDirectories,
      agent,
      cwd: resolved.cwd,
      sessionId: command.sessionId,
      signal,
    });
    const listing = await directories.list(
      command.bindingId,
      command.directoryId,
    );
    audit.record({
      commandId: command.requestId,
      event: "session_prepared",
      sessionId: command.sessionId,
    });
    send(
      socket,
      encodeSessionReadyEvent({
        additionalDirectories: resolved.additionalDirectoryEntries,
        agentId: command.agentId,
        agentName: prepared.agentName,
        agentVersion: prepared.agentVersion,
        capabilities: prepared.capabilities,
        commands: prepared.commands,
        configOptions: prepared.configOptions,
        directoryId: command.directoryId,
        directoryLabel: listing.directoryLabel,
        kind: "session.ready",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        requestId: command.requestId,
        restored: prepared.restored,
        sessionId: command.sessionId,
      }),
    );
  } catch (error) {
    reportOperationFailure(socket, command.requestId, command.sessionId, error);
  }
}

async function executeSessionConfigure(
  socket: WebSocket,
  command: SessionConfigureCommand,
  config: DaemonConfig,
  directories: WorkspaceDirectoryService,
  audit: AuditStore,
  sessions: AcpSessionManager,
  signal: AbortSignal,
): Promise<void> {
  try {
    const resolved = await resolveSessionDirectories(
      directories,
      command.bindingId,
      command.directoryId,
      command.additionalDirectoryIds,
    );
    const configOptions = await sessions.configureSession({
      additionalDirectories: resolved.additionalDirectories,
      agent: findLocalAgent(config.agents, command.agentId),
      booleanValue: command.booleanValue,
      configId: command.configId,
      cwd: resolved.cwd,
      requestId: command.requestId,
      sessionId: command.sessionId,
      signal,
      value: command.value,
      valueType: command.valueType,
    });
    audit.record({
      commandId: command.requestId,
      event: "session_configured",
      sessionId: command.sessionId,
    });
    send(
      socket,
      encodeSessionConfigUpdatedEvent({
        configOptions,
        kind: "session.config.updated",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        requestId: command.requestId,
        sessionId: command.sessionId,
      }),
    );
  } catch (error) {
    reportOperationFailure(socket, command.requestId, command.sessionId, error);
  }
}

async function executePrompt(
  socket: WebSocket,
  command: SessionPromptCommand,
  config: DaemonConfig,
  directories: WorkspaceDirectoryService,
  audit: AuditStore,
  sessions: AcpSessionManager,
  signal: AbortSignal,
): Promise<void> {
  try {
    const resolved = await resolveSessionDirectories(
      directories,
      command.bindingId,
      command.directoryId,
      command.additionalDirectoryIds,
    );
    const agent = findLocalAgent(config.agents, command.agentId);
    const processAttemptId = randomUUID();
    audit.record({
      commandId: command.commandId,
      event: "session_authorized",
      sessionId: command.sessionId,
    });
    send(
      socket,
      encodeSessionStartedEvent({
        commandId: command.commandId,
        kind: SESSION_STARTED_KIND,
        processAttemptId,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: command.sessionId,
      }),
    );

    const result = await sessions.runPrompt({
      additionalDirectories: resolved.additionalDirectories,
      agent,
      commandId: command.commandId,
      cwd: resolved.cwd,
      images: command.images,
      onActivity: (activity) => {
        send(
          socket,
          encodeAgentActivityEvent({
            activityId: activity.activityId,
            activityType: activity.activityType,
            commandId: command.commandId,
            content: activity.content,
            input: activity.input,
            kind: AGENT_ACTIVITY_KIND,
            locations: activity.locations,
            name: activity.name,
            output: activity.output,
            protocolVersion: MOBIUS_PROTOCOL_VERSION,
            sequence: activity.sequence,
            sessionId: command.sessionId,
            status: activity.status,
            title: activity.title,
            toolKind: activity.toolKind,
          }),
        );
        return Promise.resolve();
      },
      onText: (text) => {
        send(
          socket,
          encodeAgentMessageDeltaEvent({
            commandId: command.commandId,
            kind: AGENT_MESSAGE_DELTA_KIND,
            protocolVersion: MOBIUS_PROTOCOL_VERSION,
            sessionId: command.sessionId,
            text,
          }),
        );
        return Promise.resolve();
      },
      prompt: command.prompt,
      resources: command.resources,
      sessionId: command.sessionId,
      signal,
    });

    send(
      socket,
      encodeSessionCompletedEvent({
        commandId: command.commandId,
        kind: SESSION_COMPLETED_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: command.sessionId,
        stopReason: result.stopReason,
      }),
    );
    audit.record({
      commandId: command.commandId,
      event:
        result.stopReason === "cancelled"
          ? "session_cancelled"
          : "session_completed",
      sessionId: command.sessionId,
    });
  } catch (error) {
    audit.record({
      commandId: command.commandId,
      event: "session_failed",
      sessionId: command.sessionId,
    });
    reportFailure(
      socket,
      command,
      "agent_execution_failed",
      "The local agent could not complete the request",
    );
    console.error("Mobius daemon command failed", error);
  }
}

function waitForRelayRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(finish, RELAY_RECONNECT_DELAY_MILLISECONDS);

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }

    signal.addEventListener("abort", finish, { once: true });
  });
}

async function runRelayConnection(
  config: DaemonConfig,
  directories: WorkspaceDirectoryService,
  audit: AuditStore,
  sessions: AcpSessionManager,
  signal: AbortSignal,
): Promise<void> {
  const socket = await connectRelay(config.relayUrl, signal);
  const activeTurns = new Map<string, ActiveDaemonTurn>();
  const connectionController = new AbortController();
  sessions.setObserver(new DaemonAcpObserver(socket));

  await new Promise<void>((resolve, reject) => {
    let finished = false;

    const cleanup = (): void => {
      signal.removeEventListener("abort", stop);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("message", handleMessage);
      connectionController.abort();
      for (const turn of activeTurns.values()) {
        turn.abortConnection();
      }
      activeTurns.clear();
    };

    const resolveConnection = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve();
    };

    const rejectConnection = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      reject(new Error("Relay WebSocket failed"));
    };

    const stop = (): void => {
      socket.close(1000, "Daemon stopped");
      resolveConnection();
    };

    signal.addEventListener("abort", stop, { once: true });
    const handleClose = (): void => {
      resolveConnection();
    };
    const handleError = (): void => {
      if (signal.aborted) {
        resolveConnection();
        return;
      }
      rejectConnection();
    };
    const handleMessage = (event: MessageEvent<unknown>): void => {
      const encoded: unknown = event.data;
      if (typeof encoded !== "string") {
        socket.close(1003, "Text message required");
        return;
      }

      try {
        const kind = decodeMessageKind(encoded);
        if (kind === SESSION_CANCEL_KIND) {
          const cancellation = decodeSessionCancelCommand(encoded);
          const turn = activeTurns.get(cancellation.commandId);
          if (turn === undefined || !turn.matches(cancellation)) {
            console.warn(
              "Mobius daemon ignored cancellation for an inactive turn",
            );
            return;
          }
          if (!turn.requestCancellation()) {
            return;
          }
          audit.record({
            commandId: cancellation.commandId,
            event: "session_cancellation_requested",
            sessionId: cancellation.sessionId,
          });
          void sessions.cancelPrompt(cancellation.sessionId).catch((error) => {
            console.error(
              "Mobius daemon could not cancel the agent turn",
              error,
            );
          });
          return;
        }
        if (kind === WORKSPACE_LIST_KIND) {
          const command = decodeWorkspaceListCommand(encoded);
          void executeWorkspaceList(socket, command, directories, audit);
          return;
        }
        if (kind === SESSION_PREPARE_KIND) {
          const command = decodeSessionPrepareCommand(encoded);
          void executeSessionPrepare(
            socket,
            command,
            config,
            directories,
            audit,
            sessions,
            connectionController.signal,
          );
          return;
        }
        if (kind === SESSION_CONFIGURE_KIND) {
          const command = decodeSessionConfigureCommand(encoded);
          void executeSessionConfigure(
            socket,
            command,
            config,
            directories,
            audit,
            sessions,
            connectionController.signal,
          );
          return;
        }
        if (kind === SESSION_PERMISSION_RESPOND_KIND) {
          const command = decodeSessionPermissionRespondCommand(encoded);
          void sessions
            .respondPermission(command)
            .then(() => {
              audit.record({
                commandId: command.interactionId,
                event: "session_permission_resolved",
                sessionId: command.sessionId,
              });
            })
            .catch((error: unknown) => {
              reportOperationFailure(
                socket,
                command.interactionId,
                command.sessionId,
                error,
              );
            });
          return;
        }
        if (kind === SESSION_ELICITATION_RESPOND_KIND) {
          const command = decodeSessionElicitationRespondCommand(encoded);
          void sessions
            .respondElicitation(command)
            .then(() => {
              audit.record({
                commandId: command.interactionId,
                event: "session_elicitation_resolved",
                sessionId: command.sessionId,
              });
            })
            .catch((error: unknown) => {
              reportOperationFailure(
                socket,
                command.interactionId,
                command.sessionId,
                error,
              );
            });
          return;
        }
        if (kind !== SESSION_PROMPT_KIND) {
          socket.close(1008, "Unsupported protocol message");
          return;
        }
        const command = decodeSessionPromptCommand(encoded);
        if (activeTurns.has(command.commandId)) {
          reportFailure(
            socket,
            command,
            "duplicate_command",
            "The command is already running",
          );
          return;
        }

        const turn = new ActiveDaemonTurn(command, new AbortController());
        activeTurns.set(command.commandId, turn);
        void executePrompt(
          socket,
          command,
          config,
          directories,
          audit,
          sessions,
          turn.signal,
        )
          .catch((error: unknown) => {
            console.error("Mobius daemon turn failed", error);
          })
          .finally(() => {
            activeTurns.delete(command.commandId);
          });
      } catch (error) {
        console.error("Mobius daemon rejected a message", error);
        socket.close(1008, "Invalid protocol message");
      }
    };
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
    socket.addEventListener("message", handleMessage);

    if (signal.aborted) {
      stop();
    }
  });
}

export async function runDaemon(
  config: DaemonConfig,
  audit: AuditStore,
  signal: AbortSignal,
): Promise<void> {
  const sessionStore = new SqliteAcpSessionStore(config.auditDatabasePath);
  const sessions = new AcpSessionManager(
    new NullAcpSessionObserver(),
    sessionStore,
  );
  const directories = new WorkspaceDirectoryService(
    config.bindingId,
    config.approvedRoot,
  );
  let retryAnnounced = false;

  try {
    while (!signal.aborted) {
      try {
        await runRelayConnection(config, directories, audit, sessions, signal);
        retryAnnounced = false;
      } catch {
        if (signal.aborted) {
          return;
        }
        if (!retryAnnounced) {
          console.warn("Mobius daemon is waiting for the relay");
          retryAnnounced = true;
        }
      }

      await waitForRelayRetry(signal);
    }
  } finally {
    await sessions.close();
    sessionStore.close();
  }
}
