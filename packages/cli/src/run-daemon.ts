import { basename } from "node:path";
import { styleText } from "node:util";

import {
  AGENT_ACTIVITY_KIND,
  AGENT_INSTALL_AWAITING_APPROVAL_KIND,
  AGENT_INSTALL_CANCEL_KIND,
  AGENT_INSTALL_CANCELLED_KIND,
  AGENT_INSTALL_COMPLETED_KIND,
  AGENT_INSTALL_FAILED_KIND,
  AGENT_INSTALL_PROGRESS_KIND,
  AGENT_INSTALL_REQUEST_KIND,
  AGENT_INSTALL_STARTED_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  type AgentContentEvent,
  decodeAgentInstallCancelCommand,
  decodeAgentInstallRequestCommand,
  decodeMessageKind,
  decodeNativeSessionCancel,
  decodeNativeSessionCommand,
  decodeRuntimeHeartbeatAckEvent,
  decodeRuntimeLivenessReadyEvent,
  decodeSessionCancelCommand,
  decodeSessionConfigureCommand,
  decodeSessionElicitationRespondCommand,
  decodeSessionEventAcknowledgement,
  decodeSessionPermissionRespondCommand,
  decodeSessionPrepareCommand,
  decodeSessionPromptCommand,
  decodeWorkspaceListCommand,
  encodeAgentActivityEvent,
  encodeAgentContentEvent,
  encodeAgentInstallAwaitingApprovalEvent,
  encodeAgentInstallCancelledEvent,
  encodeAgentInstallCompletedEvent,
  encodeAgentInstallFailedEvent,
  encodeAgentInstallProgressEvent,
  encodeAgentInstallStartedEvent,
  encodeAgentMessageDeltaEvent,
  encodeNativeSessionResult,
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
  NATIVE_SESSION_CANCEL_KIND,
  NATIVE_SESSION_REQUEST_KIND,
  RUNTIME_HEARTBEAT_ACK_KIND,
  RUNTIME_LIVENESS_READY_KIND,
  SESSION_CANCEL_KIND,
  SESSION_COMPLETED_KIND,
  SESSION_CONFIGURE_KIND,
  SESSION_ELICITATION_RESPOND_KIND,
  SESSION_EVENT_ACK_KIND,
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
import { supportedLocalAgentSpecifications } from "./agent-catalog/discover-local-agents.ts";
import { LocalAgentCatalogError } from "./agent-catalog/local-agent.ts";
import { publishAgentCatalog } from "./agent-catalog/publish-agent-catalog.ts";
import {
  type AgentInstallation,
  AgentInstallationManager,
  AwaitingLocalApproval,
  CancelledInstallation,
  FailedInstallation,
  type InstallationAudit,
  type InstallationObserver,
  RequestedInstallation,
  RunningInstallation,
  SucceededInstallation,
} from "./agent-installation/agent-installation-manager.ts";
import { AutomaticAdapterProvisioner } from "./agent-installation/automatic-adapter-provisioner.ts";
import { FixedInstallationExecutor } from "./agent-installation/fixed-installation-executor.ts";
import { ConsoleInstallationAuthorizer } from "./agent-installation/local-installation-authorizer.ts";
import { ManagedAdapterInstaller } from "./agent-installation/managed-adapter-installer.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { LocalAuthorizationError } from "./authorization/local-authorization-error.ts";
import { WorkspaceDirectoryService } from "./authorization/workspace-directory.ts";
import type { DaemonConfig } from "./config.ts";
import { NativeSessionService } from "./native-sessions/service.ts";
import { connectRelay } from "./relay-connection/connect.ts";
import { RelayConnectionLiveness } from "./relay-connection/liveness.ts";
import { SessionEventOutbox } from "./relay-connection/session-event-outbox.ts";
import {
  type DaemonScheduledTask,
  type DaemonTimer,
  systemDaemonTimer,
} from "./relay-connection/timer.ts";
import { readStateDirectory } from "./storage/state-directory.ts";

const RELAY_RECONNECT_DELAY_MILLISECONDS = 500;
const RELAY_CONNECTION_REFRESH_MILLISECONDS = 20 * 60 * 1_000;

abstract class RelayConnectionRefreshState {}

class ScheduledRelayConnectionRefreshState extends RelayConnectionRefreshState {}

class DueRelayConnectionRefreshState extends RelayConnectionRefreshState {}

class FinishedRelayConnectionRefreshState extends RelayConnectionRefreshState {}

class RelayConnectionRefresh {
  readonly #isSafe: () => boolean;
  readonly #refresh: () => void;
  readonly #scheduledTask: DaemonScheduledTask;
  #state: RelayConnectionRefreshState =
    new ScheduledRelayConnectionRefreshState();

  constructor(timer: DaemonTimer, isSafe: () => boolean, refresh: () => void) {
    this.#isSafe = isSafe;
    this.#refresh = refresh;
    this.#scheduledTask = timer.schedule(
      this.#request,
      RELAY_CONNECTION_REFRESH_MILLISECONDS,
    );
  }

  readonly afterTurnFinished = (): void => {
    if (this.#state instanceof DueRelayConnectionRefreshState) {
      this.#request();
      return;
    }
    if (
      this.#state instanceof ScheduledRelayConnectionRefreshState ||
      this.#state instanceof FinishedRelayConnectionRefreshState
    ) {
      return;
    }
    throw new Error("Unknown relay connection refresh state");
  };

  readonly close = (): void => {
    this.#scheduledTask.cancel();
    this.#state = new FinishedRelayConnectionRefreshState();
  };

  readonly #request = (): void => {
    if (this.#state instanceof FinishedRelayConnectionRefreshState) {
      return;
    }
    if (
      !(this.#state instanceof ScheduledRelayConnectionRefreshState) &&
      !(this.#state instanceof DueRelayConnectionRefreshState)
    ) {
      throw new Error("Unknown relay connection refresh state");
    }
    if (!this.#isSafe()) {
      this.#state = new DueRelayConnectionRefreshState();
      return;
    }
    this.#state = new FinishedRelayConnectionRefreshState();
    this.#scheduledTask.cancel();
    this.#refresh();
  };
}

class DaemonAcpObserver implements AcpSessionObserver {
  readonly #record: (sessionId: string, payload: string) => void;

  constructor(record: (sessionId: string, payload: string) => void) {
    this.#record = record;
  }

  readonly onCommands = (event: SessionCommandsUpdatedEvent): Promise<void> => {
    this.#record(event.sessionId, encodeSessionCommandsUpdatedEvent(event));
    return Promise.resolve();
  };

  readonly onConfig = (event: SessionConfigUpdatedEvent): Promise<void> => {
    this.#record(event.sessionId, encodeSessionConfigUpdatedEvent(event));
    return Promise.resolve();
  };

  readonly onContent = (event: AgentContentEvent): Promise<void> => {
    this.#record(event.sessionId, encodeAgentContentEvent(event));
    return Promise.resolve();
  };

  readonly onElicitation = (
    event: SessionElicitationRequestedEvent,
  ): Promise<void> => {
    this.#record(
      event.sessionId,
      encodeSessionElicitationRequestedEvent(event),
    );
    return Promise.resolve();
  };

  readonly onElicitationResolved = (
    event: SessionElicitationResolvedEvent,
  ): Promise<void> => {
    this.#record(event.sessionId, encodeSessionElicitationResolvedEvent(event));
    return Promise.resolve();
  };

  readonly onInfo = (event: SessionInfoUpdatedEvent): Promise<void> => {
    this.#record(event.sessionId, encodeSessionInfoUpdatedEvent(event));
    return Promise.resolve();
  };

  readonly onPermission = (
    event: SessionPermissionRequestedEvent,
  ): Promise<void> => {
    this.#record(event.sessionId, encodeSessionPermissionRequestedEvent(event));
    return Promise.resolve();
  };

  readonly onPermissionResolved = (
    event: SessionPermissionResolvedEvent,
  ): Promise<void> => {
    this.#record(event.sessionId, encodeSessionPermissionResolvedEvent(event));
    return Promise.resolve();
  };

  readonly onUsage = (event: SessionUsageUpdatedEvent): Promise<void> => {
    this.#record(event.sessionId, encodeSessionUsageUpdatedEvent(event));
    return Promise.resolve();
  };
}

class AuditInstallationEvents implements InstallationAudit {
  readonly #audit: AuditStore;

  constructor(audit: AuditStore) {
    this.#audit = audit;
  }

  readonly record = (
    event: string,
    requestId: string,
    agentId: string,
    details: Readonly<Record<string, string>> = {},
  ): void => {
    this.#audit.record({
      commandId: requestId,
      details,
      event,
      sessionId: `agent-installation:${agentId}`,
    });
  };
}

class DaemonInstallationObserver implements InstallationObserver {
  readonly #started = new Set<string>();
  #socket: WebSocket | null = null;

  readonly connect = (socket: WebSocket): void => {
    this.#socket = socket;
  };

  readonly disconnect = (socket: WebSocket): void => {
    if (this.#socket === socket) {
      this.#socket = null;
    }
  };

  readonly #send = (socket: WebSocket, message: string): void => {
    try {
      send(socket, message);
    } catch {
      if (this.#socket === socket) {
        this.#socket = null;
      }
    }
  };

  readonly onState = (state: AgentInstallation): Promise<void> => {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (state instanceof RequestedInstallation) {
      return Promise.resolve();
    }
    if (state instanceof AwaitingLocalApproval) {
      this.#send(
        socket,
        encodeAgentInstallAwaitingApprovalEvent({
          agentId: state.agentId,
          kind: AGENT_INSTALL_AWAITING_APPROVAL_KIND,
          requestId: state.requestId,
        }),
      );
      return Promise.resolve();
    }
    if (state instanceof RunningInstallation) {
      if (!this.#started.has(state.requestId)) {
        this.#started.add(state.requestId);
        this.#send(
          socket,
          encodeAgentInstallStartedEvent({
            agentId: state.agentId,
            kind: AGENT_INSTALL_STARTED_KIND,
            requestId: state.requestId,
          }),
        );
      }
      this.#send(
        socket,
        encodeAgentInstallProgressEvent({
          agentId: state.agentId,
          kind: AGENT_INSTALL_PROGRESS_KIND,
          requestId: state.requestId,
          stage: state.stage,
        }),
      );
      return Promise.resolve();
    }
    if (state instanceof SucceededInstallation) {
      this.#send(
        socket,
        encodeAgentInstallCompletedEvent({
          agentId: state.agentId,
          authenticationMayBeRequired: state.authenticationMayBeRequired,
          kind: AGENT_INSTALL_COMPLETED_KIND,
          requestId: state.requestId,
        }),
      );
      return Promise.resolve();
    }
    if (state instanceof FailedInstallation) {
      this.#send(
        socket,
        encodeAgentInstallFailedEvent({
          agentId: state.agentId,
          code: state.code,
          kind: AGENT_INSTALL_FAILED_KIND,
          message: state.message,
          requestId: state.requestId,
        }),
      );
      return Promise.resolve();
    }
    if (state instanceof CancelledInstallation) {
      this.#send(
        socket,
        encodeAgentInstallCancelledEvent({
          agentId: state.agentId,
          kind: AGENT_INSTALL_CANCELLED_KIND,
          requestId: state.requestId,
        }),
      );
      return Promise.resolve();
    }
    throw new Error("Unsupported Agent installation state");
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

function recordSessionEvent(
  outbox: SessionEventOutbox,
  socket: WebSocket,
  sessionId: string,
  payload: string,
  attemptId: string | null = null,
): void {
  const envelope = outbox.enqueue(sessionId, payload, attemptId);
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(envelope);
  }
}

function reportFailure(
  outbox: SessionEventOutbox,
  socket: WebSocket,
  command: SessionPromptCommand,
  code: string,
  message: string,
  attemptId: string | null = null,
): void {
  recordSessionEvent(
    outbox,
    socket,
    command.sessionId,
    encodeSessionFailedEvent({
      code,
      commandId: command.commandId,
      kind: SESSION_FAILED_KIND,
      message,
      sessionId: command.sessionId,
    }),
    attemptId,
  );
}

function operationErrorCode(error: unknown): string {
  if (
    error instanceof AcpExecutionError ||
    error instanceof LocalAuthorizationError ||
    error instanceof LocalAgentCatalogError
  ) {
    return error.code;
  }
  return "session_operation_failed";
}

function operationErrorMessage(error: unknown): string {
  if (
    error instanceof AcpExecutionError ||
    error instanceof LocalAuthorizationError ||
    error instanceof LocalAgentCatalogError
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
  signal: AbortSignal,
): Promise<ResolvedSessionDirectories> {
  const cwd = await directories.resolve(bindingId, directoryId, signal);
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
      signal,
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
  signal: AbortSignal,
): Promise<void> {
  try {
    const listing = await directories.list(
      command.bindingId,
      command.directoryId,
      signal,
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
        requestId: command.requestId,
      }),
    );
  } catch (error) {
    reportOperationFailure(socket, command.requestId, "", error);
  }
}

async function executeSessionPrepare(
  outbox: SessionEventOutbox,
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
      config.bindingId,
      command.directoryId,
      command.additionalDirectoryIds,
      signal,
    );
    const agent = config.catalog.find(command.agentId);
    const prepared = await sessions.prepareSession({
      additionalDirectories: resolved.additionalDirectories,
      agent,
      cwd: resolved.cwd,
      sessionId: command.sessionId,
      signal,
    });
    const listing = await directories.list(
      config.bindingId,
      command.directoryId,
      signal,
    );
    audit.record({
      commandId: command.requestId,
      event: "session_prepared",
      sessionId: command.sessionId,
    });
    recordSessionEvent(
      outbox,
      socket,
      command.sessionId,
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
        requestId: command.requestId,
        restored: prepared.restored,
        sessionId: command.sessionId,
      }),
    );
  } catch (error) {
    audit.record({
      commandId: command.requestId,
      details: {
        agentId: command.agentId,
        code: operationErrorCode(error),
      },
      event: "session_prepare_failed",
      sessionId: command.sessionId,
    });
    reportOperationFailure(socket, command.requestId, command.sessionId, error);
  }
}

async function executeSessionConfigure(
  outbox: SessionEventOutbox,
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
      config.bindingId,
      command.directoryId,
      command.additionalDirectoryIds,
      signal,
    );
    const configOptions = await sessions.configureSession({
      additionalDirectories: resolved.additionalDirectories,
      agent: config.catalog.find(command.agentId),
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
    recordSessionEvent(
      outbox,
      socket,
      command.sessionId,
      encodeSessionConfigUpdatedEvent({
        configOptions,
        kind: "session.config.updated",
        requestId: command.requestId,
        sessionId: command.sessionId,
      }),
    );
  } catch (error) {
    reportOperationFailure(socket, command.requestId, command.sessionId, error);
  }
}

async function executePrompt(
  outbox: SessionEventOutbox,
  socket: WebSocket,
  command: SessionPromptCommand,
  config: DaemonConfig,
  directories: WorkspaceDirectoryService,
  audit: AuditStore,
  sessions: AcpSessionManager,
  attemptId: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const resolved = await resolveSessionDirectories(
      directories,
      config.bindingId,
      command.directoryId,
      command.additionalDirectoryIds,
      signal,
    );
    const agent = config.catalog.find(command.agentId);
    audit.record({
      commandId: command.commandId,
      event: "session_authorized",
      sessionId: command.sessionId,
    });
    outbox.transitionExecution(command.commandId, "running");
    recordSessionEvent(
      outbox,
      socket,
      command.sessionId,
      encodeSessionStartedEvent({
        commandId: command.commandId,
        kind: SESSION_STARTED_KIND,
        attemptId,
        sessionId: command.sessionId,
      }),
      attemptId,
    );
    const result = await sessions.runPrompt({
      additionalDirectories: resolved.additionalDirectories,
      agent,
      commandId: command.commandId,
      cwd: resolved.cwd,
      images: command.images,
      onActivity: (activity) => {
        recordSessionEvent(
          outbox,
          socket,
          command.sessionId,
          encodeAgentActivityEvent({
            activityId: activity.activityId,
            activityType: activity.activityType,
            commandId: command.commandId,
            content: activity.content,
            detail: activity.detail,
            input: activity.input,
            kind: AGENT_ACTIVITY_KIND,
            locations: activity.locations,
            name: activity.name,
            output: activity.output,
            sequence: activity.sequence,
            sessionId: command.sessionId,
            status: activity.status,
            title: activity.title,
            toolKind: activity.toolKind,
          }),
          attemptId,
        );
        return Promise.resolve();
      },
      onText: (text) => {
        recordSessionEvent(
          outbox,
          socket,
          command.sessionId,
          encodeAgentMessageDeltaEvent({
            commandId: command.commandId,
            kind: AGENT_MESSAGE_DELTA_KIND,
            sessionId: command.sessionId,
            text,
          }),
          attemptId,
        );
        return Promise.resolve();
      },
      prompt: command.prompt,
      resources: command.resources,
      sessionId: command.sessionId,
      signal,
    });

    recordSessionEvent(
      outbox,
      socket,
      command.sessionId,
      encodeSessionCompletedEvent({
        commandId: command.commandId,
        kind: SESSION_COMPLETED_KIND,
        sessionId: command.sessionId,
        stopReason: result.stopReason,
      }),
      attemptId,
    );
    outbox.transitionExecution(
      command.commandId,
      result.stopReason === "cancelled" ? "cancelled" : "succeeded",
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
    const code = operationErrorCode(error);
    reportFailure(
      outbox,
      socket,
      command,
      code === "session_operation_failed" ? "agent_execution_failed" : code,
      code === "session_operation_failed"
        ? "The local agent could not complete the request"
        : operationErrorMessage(error),
      attemptId,
    );
    outbox.transitionExecution(command.commandId, "failed");
    console.error("Mobius daemon command failed", error);
  }
}

function waitForRelayRetry(
  signal: AbortSignal,
  timer: DaemonTimer,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const retry = timer.schedule(finish, RELAY_RECONNECT_DELAY_MILLISECONDS);

    function finish(): void {
      retry.cancel();
      signal.removeEventListener("abort", finish);
      resolve();
    }

    signal.addEventListener("abort", finish, { once: true });
  });
}

async function publishAgentCatalogUntilAvailable(
  config: DaemonConfig,
  signal: AbortSignal,
  timer: DaemonTimer,
): Promise<void> {
  try {
    await publishAgentCatalog(config, signal);
    return;
  } catch {
    if (signal.aborted) {
      return;
    }
    console.warn("Mobius daemon is waiting to publish its Agent catalog");
  }

  while (!signal.aborted) {
    await waitForRelayRetry(signal, timer);
    try {
      await publishAgentCatalog(config, signal);
      return;
    } catch {
      if (signal.aborted) {
        return;
      }
    }
  }
}

async function runRelayConnection(
  config: DaemonConfig,
  directories: WorkspaceDirectoryService,
  audit: AuditStore,
  sessions: AcpSessionManager,
  installations: AgentInstallationManager,
  installationObserver: DaemonInstallationObserver,
  nativeSessions: NativeSessionService,
  outbox: SessionEventOutbox,
  onConnected: () => void,
  signal: AbortSignal,
  timer: DaemonTimer,
): Promise<void> {
  const relayUrl = new URL(config.relayUrl);
  relayUrl.searchParams.set("liveness", "1");
  const socket = await connectRelay(relayUrl, signal);
  onConnected();
  const activeTurns = new Map<string, ActiveDaemonTurn>();
  const activeAttemptIds = new Map<string, string>();
  const connectionController = new AbortController();
  const nativeRequests = new Map<
    string,
    {
      readonly agentId: string;
      readonly sessionId: string;
      readonly controller: AbortController;
      readonly completion: Promise<void>;
    }
  >();
  const record = (sessionId: string, payload: string): void => {
    recordSessionEvent(
      outbox,
      socket,
      sessionId,
      payload,
      activeAttemptIds.get(sessionId) ?? null,
    );
  };
  sessions.setObserver(new DaemonAcpObserver(record));
  installationObserver.connect(socket);
  for (const pending of outbox.pending()) {
    send(socket, pending);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;

      const cleanup = (): void => {
        connectionRefresh.close();
        connectionLiveness.close();
        signal.removeEventListener("abort", stop);
        socket.removeEventListener("close", handleClose);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("message", handleMessage);
        installationObserver.disconnect(socket);
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

      const refreshConnection = (): void => {
        socket.close(1000, "Refreshing idle relay connection");
        resolveConnection();
      };

      const connectionLiveness = new RelayConnectionLiveness(timer, {
        send: (message) => send(socket, message),
        unresponsive: () => {
          socket.close(4001, "Relay liveness check timed out");
          resolveConnection();
        },
      });

      const connectionRefresh = new RelayConnectionRefresh(
        timer,
        () => activeTurns.size === 0,
        refreshConnection,
      );

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
          socket.close(4003, "Text message required");
          rejectConnection();
          return;
        }

        try {
          const kind = decodeMessageKind(encoded);
          if (kind === SESSION_EVENT_ACK_KIND) {
            outbox.acknowledge(decodeSessionEventAcknowledgement(encoded));
            return;
          }
          if (kind === NATIVE_SESSION_CANCEL_KIND) {
            const command = decodeNativeSessionCancel(encoded);
            const pending = nativeRequests.get(command.requestId);
            if (pending?.sessionId === command.sessionId)
              pending.controller.abort(
                new AcpExecutionError(
                  "Native session operation cancelled",
                  {},
                  "native_session_cancelled",
                ),
              );
            return;
          }
          if (kind === NATIVE_SESSION_REQUEST_KIND) {
            const command = decodeNativeSessionCommand(encoded);
            const previous = [...nativeRequests.values()].filter(
              (request) => request.agentId === command.agentId,
            );
            if (
              nativeRequests.has(command.requestId) ||
              nativeRequests.size >= 4 ||
              previous.some((request) => !request.controller.signal.aborted)
            ) {
              reportOperationFailure(
                socket,
                command.requestId,
                command.sessionId,
                new AcpExecutionError(
                  "Another native session operation is running",
                  {},
                  "native_session_busy",
                ),
              );
              return;
            }
            const controller = new AbortController();
            const operationSignal = AbortSignal.any([
              connectionController.signal,
              controller.signal,
            ]);
            const timeout = timer.schedule(
              () =>
                controller.abort(
                  new AcpExecutionError(
                    "Native session operation timed out",
                    {},
                    "native_session_timeout",
                  ),
                ),
              90_000,
            );
            const completion = (async (): Promise<void> => {
              try {
                operationSignal.throwIfAborted();
                if (previous.length > 0) {
                  await new Promise<void>((resolve, reject) => {
                    const cancel = (): void => reject(operationSignal.reason);
                    operationSignal.addEventListener("abort", cancel, {
                      once: true,
                    });
                    void Promise.all(
                      previous.map((request) => request.completion),
                    ).then(
                      () => {
                        operationSignal.removeEventListener("abort", cancel);
                        resolve();
                      },
                      (error: unknown) => {
                        operationSignal.removeEventListener("abort", cancel);
                        reject(error);
                      },
                    );
                  });
                }
                operationSignal.throwIfAborted();
                const result = await nativeSessions.execute(
                  command,
                  operationSignal,
                );
                if (socket.readyState === WebSocket.OPEN)
                  send(socket, encodeNativeSessionResult(result));
              } catch (error) {
                const failure: unknown = operationSignal.aborted
                  ? (controller.signal.reason ??
                    new AcpExecutionError(
                      "Native session operation cancelled",
                      {},
                      "native_session_cancelled",
                    ))
                  : error;
                audit.record({
                  commandId: command.requestId,
                  sessionId: command.sessionId,
                  event: "native_session_operation_failed",
                  details: { code: operationErrorCode(failure) },
                });
                reportOperationFailure(
                  socket,
                  command.requestId,
                  command.sessionId,
                  failure,
                );
              } finally {
                timeout.cancel();
                nativeRequests.delete(command.requestId);
              }
            })();
            nativeRequests.set(command.requestId, {
              agentId: command.agentId,
              sessionId: command.sessionId,
              controller,
              completion,
            });
            return;
          }
          if (kind === RUNTIME_LIVENESS_READY_KIND) {
            decodeRuntimeLivenessReadyEvent(encoded);
            connectionLiveness.start();
            return;
          }
          if (kind === RUNTIME_HEARTBEAT_ACK_KIND) {
            connectionLiveness.acknowledge(
              decodeRuntimeHeartbeatAckEvent(encoded),
            );
            return;
          }
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
            void sessions
              .cancelPrompt(cancellation.sessionId)
              .catch((error) => {
                console.error(
                  "Mobius daemon could not cancel the agent turn",
                  error,
                );
              });
            return;
          }
          if (kind === WORKSPACE_LIST_KIND) {
            const command = decodeWorkspaceListCommand(encoded);
            void executeWorkspaceList(
              socket,
              command,
              directories,
              audit,
              connectionController.signal,
            );
            return;
          }
          if (kind === SESSION_PREPARE_KIND) {
            const command = decodeSessionPrepareCommand(encoded);
            void executeSessionPrepare(
              outbox,
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
              outbox,
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
          if (kind === AGENT_INSTALL_REQUEST_KIND) {
            const command = decodeAgentInstallRequestCommand(encoded);
            void installations
              .request(command, signal)
              .catch((error: unknown) => {
                console.error("Mobius Agent installation failed", error);
              });
            return;
          }
          if (kind === AGENT_INSTALL_CANCEL_KIND) {
            const command = decodeAgentInstallCancelCommand(encoded);
            void installations
              .cancel(command.requestId)
              .catch((error: unknown) => {
                reportOperationFailure(socket, command.requestId, "", error);
              });
            return;
          }
          if (kind !== SESSION_PROMPT_KIND) {
            throw new Error("Unsupported protocol message");
          }
          const command = decodeSessionPromptCommand(encoded);
          if (activeTurns.has(command.commandId)) {
            return;
          }

          const receipt = outbox.claimExecution(
            command.commandId,
            command.sessionId,
            encoded,
          );
          if (receipt.kind === "duplicate") {
            return;
          }

          const turn = new ActiveDaemonTurn(command, new AbortController());
          activeTurns.set(command.commandId, turn);
          activeAttemptIds.set(command.sessionId, receipt.attemptId);
          void executePrompt(
            outbox,
            socket,
            command,
            config,
            directories,
            audit,
            sessions,
            receipt.attemptId,
            turn.signal,
          )
            .catch((error: unknown) => {
              console.error("Mobius daemon turn failed", error);
            })
            .finally(() => {
              activeTurns.delete(command.commandId);
              if (
                activeAttemptIds.get(command.sessionId) === receipt.attemptId
              ) {
                activeAttemptIds.delete(command.sessionId);
              }
              connectionRefresh.afterTurnFinished();
            });
        } catch (error) {
          console.error("Mobius daemon rejected a message", error);
          socket.close(4008, "Invalid protocol message");
          rejectConnection();
        }
      };
      socket.addEventListener("close", handleClose);
      socket.addEventListener("error", handleError);
      socket.addEventListener("message", handleMessage);

      if (signal.aborted) {
        stop();
      }
    });
  } finally {
    connectionController.abort();
    await Promise.all(
      [...nativeRequests.values()].map((request) => request.completion),
    );
  }
}

export async function runDaemon(
  config: DaemonConfig,
  audit: AuditStore,
  signal: AbortSignal,
  timer: DaemonTimer = systemDaemonTimer,
): Promise<void> {
  const installationAudit = new AuditInstallationEvents(audit);
  const stateDirectory = readStateDirectory();
  const specifications = supportedLocalAgentSpecifications();
  const installationExecutor = new FixedInstallationExecutor({
    defaultWorkspace: config.defaultWorkspace,
    audit: installationAudit,
    catalog: config.catalog,
    environment: process.env,
    publishCatalog: async (installationSignal) =>
      await publishAgentCatalog(config, installationSignal),
    stateDirectory,
  });
  await new AutomaticAdapterProvisioner(
    {
      defaultWorkspace: config.defaultWorkspace,
      audit: installationAudit,
      catalog: config.catalog,
      environment: process.env,
    },
    new ManagedAdapterInstaller({
      environment: process.env,
      stateDirectory,
    }),
    specifications,
  ).prepare(signal);

  const sessionStore = new SqliteAcpSessionStore(config.auditDatabasePath);
  const outbox = new SessionEventOutbox(config.auditDatabasePath);
  const sessions = new AcpSessionManager(
    new NullAcpSessionObserver(),
    sessionStore,
  );
  const directories = new WorkspaceDirectoryService(
    config.bindingId,
    config.defaultWorkspace,
  );
  const installationObserver = new DaemonInstallationObserver();
  const nativeSessions = new NativeSessionService(
    config,
    directories,
    sessions,
    audit,
  );
  const installations = new AgentInstallationManager(
    specifications,
    new ConsoleInstallationAuthorizer(stateDirectory),
    installationExecutor,
    installationObserver,
    installationAudit,
  );
  let retryAnnounced = false;
  let connectionAnnounced = false;
  const announceConnection = (): void => {
    if (connectionAnnounced) {
      return;
    }
    connectionAnnounced = true;
    const reconnectCommand = `npx --yes @moxt-ai/mobius start --channel ${config.channelId}`;
    process.stdout.write("Mobius daemon connected to the relay.\n\n");
    process.stdout.write(
      `${styleText(
        ["bold", "yellow"],
        `Reconnect this channel later:\n  ${reconnectCommand}`,
      )}\n\n`,
    );
  };
  const catalogPublication = publishAgentCatalogUntilAvailable(
    config,
    signal,
    timer,
  );

  try {
    while (!signal.aborted) {
      try {
        await runRelayConnection(
          config,
          directories,
          audit,
          sessions,
          installations,
          installationObserver,
          nativeSessions,
          outbox,
          announceConnection,
          signal,
          timer,
        );
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

      await waitForRelayRetry(signal, timer);
    }
  } finally {
    try {
      await catalogPublication;
    } finally {
      try {
        await installations.close();
      } finally {
        try {
          await sessions.close();
        } finally {
          try {
            sessionStore.close();
          } finally {
            outbox.close();
          }
        }
      }
    }
  }
}
