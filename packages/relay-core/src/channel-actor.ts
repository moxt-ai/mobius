import {
  AGENT_INSTALL_AWAITING_APPROVAL_KIND,
  AGENT_INSTALL_CANCEL_KIND,
  AGENT_INSTALL_CANCELLED_KIND,
  AGENT_INSTALL_COMPLETED_KIND,
  AGENT_INSTALL_FAILED_KIND,
  AGENT_INSTALL_PROGRESS_KIND,
  AGENT_INSTALL_REQUEST_KIND,
  AGENT_INSTALL_STARTED_KIND,
  decodeAgentInstallAwaitingApprovalEvent,
  decodeAgentInstallCancelCommand,
  decodeAgentInstallCancelledEvent,
  decodeAgentInstallCompletedEvent,
  decodeAgentInstallFailedEvent,
  decodeAgentInstallProgressEvent,
  decodeAgentInstallRequestCommand,
  decodeAgentInstallStartedEvent,
  decodeMessageKind,
  decodeNativeSessionCancel,
  decodeNativeSessionCommand,
  decodeNativeSessionResult,
  decodeSessionCancelCommand,
  decodeSessionConfigureCommand,
  decodeSessionElicitationRespondCommand,
  decodeSessionEventEnvelope,
  decodeSessionOperationFailedEvent,
  decodeSessionPermissionRespondCommand,
  decodeSessionPrepareCommand,
  decodeSessionPromptCommand,
  decodeWorkspaceEntriesEvent,
  decodeWorkspaceListCommand,
  encodeCommittedSessionEvent,
  encodeNativeSessionResult,
  encodeRuntimeStatusEvent,
  encodeSessionEventAcknowledgement,
  encodeSessionFailedEvent,
  encodeSessionOperationFailedEvent,
  NATIVE_SESSION_CANCEL_KIND,
  NATIVE_SESSION_REQUEST_KIND,
  NATIVE_SESSION_RESULT_KIND,
  type NativeSessionHistory,
  ProtocolMessageError,
  RUNTIME_STATUS_KIND,
  SESSION_CANCEL_KIND,
  SESSION_CONFIGURE_KIND,
  SESSION_ELICITATION_RESPOND_KIND,
  SESSION_EVENT_ACK_KIND,
  SESSION_EVENT_KIND,
  SESSION_FAILED_KIND,
  SESSION_OPERATION_FAILED_KIND,
  SESSION_PERMISSION_RESPOND_KIND,
  SESSION_PREPARE_KIND,
  SESSION_PROMPT_KIND,
  WORKSPACE_ENTRIES_KIND,
  WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";

import {
  CreateSessionBindingRequest,
  CreateSessionRequest,
  type ProjectScope,
  type SessionMessage,
  SessionRecordingPolicy,
  type SessionRuntime,
  SessionRuntimeError,
} from "./session-runtime.ts";

const DEFAULT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const MINIMUM_TRUNCATED_HISTORY_MATCH_CHARACTERS = 32;

function reconcileNativeHistoryCoverage(
  history: NativeSessionHistory,
  messages: readonly SessionMessage[],
): NativeSessionHistory {
  if (history.status !== "available") {
    return history;
  }
  let historyIndex = history.messages.length;
  const coveredCommandIds: string[] = [];
  const coveredMessageIds: string[] = [];
  for (const message of messages) {
    let assistantStartIndex = historyIndex;
    while (
      assistantStartIndex > 0 &&
      history.messages[assistantStartIndex - 1]?.role === "assistant"
    ) {
      assistantStartIndex -= 1;
    }
    if (assistantStartIndex === historyIndex) {
      break;
    }
    const assistantText = history.messages
      .slice(assistantStartIndex, historyIndex)
      .map((entry) => entry.text)
      .join("");
    const user = history.messages[assistantStartIndex - 1];
    if (
      user?.role === "user" &&
      user.text === message.prompt &&
      assistantText === message.response &&
      message.images.length === 0 &&
      message.resources.length === 0
    ) {
      coveredCommandIds.push(message.commandId);
      coveredMessageIds.push(
        `${message.commandId}:user`,
        `${message.commandId}:agent`,
      );
      historyIndex = assistantStartIndex - 1;
      continue;
    }
    if (
      history.truncated &&
      assistantStartIndex === 0 &&
      assistantText.length >= MINIMUM_TRUNCATED_HISTORY_MATCH_CHARACTERS &&
      message.response.endsWith(assistantText)
    ) {
      coveredMessageIds.push(`${message.commandId}:agent`);
      historyIndex = 0;
      continue;
    }
    break;
  }
  return { ...history, coveredCommandIds, coveredMessageIds };
}

function sessionErrorCloseCode(error: SessionRuntimeError): 1008 | 1011 | 1013 {
  if (
    error.code === "session_busy" ||
    error.code === "session_quota_exceeded"
  ) {
    return 1013;
  }
  if (
    error.code === "session_storage_timeout" ||
    error.code === "session_storage_unavailable"
  ) {
    return 1011;
  }
  return 1008;
}

export interface RelayClock {
  readonly now: () => number;
}

export class SystemRelayClock implements RelayClock {
  readonly now = (): number => Date.now();
}

export interface ChannelSocket {
  readonly close: (code: number, reason: string) => void;
  readonly isOpen: () => boolean;
  readonly isSame: (socket: ChannelSocket) => boolean;
  readonly send: (message: string) => void;
}

export interface ChannelPeers {
  readonly daemons: () => readonly ChannelSocket[];
  readonly hosts: () => readonly ChannelSocket[];
}

export class ChannelActor {
  readonly #clock: RelayClock;
  readonly #peers: ChannelPeers;
  readonly #runtime: SessionRuntime;
  readonly #runtimeId: string;
  readonly #scope: ProjectScope;

  constructor(
    runtimeId: string,
    scope: ProjectScope,
    runtime: SessionRuntime,
    peers: ChannelPeers,
    clock: RelayClock = new SystemRelayClock(),
  ) {
    this.#clock = clock;
    this.#peers = peers;
    this.#runtime = runtime;
    this.#runtimeId = runtimeId;
    this.#scope = scope;
  }

  readonly attachDaemon = async (
    replacedExistingConnection: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    if (replacedExistingConnection) {
      await this.#runtime.markRuntimeDisconnected(
        this.#scope,
        this.#runtimeId,
        this.#clock.now(),
        signal,
      );
    }
    this.broadcastRuntimeStatus(true);
    await this.deliverPendingDaemonWork(signal);
  };

  readonly attachHost = (
    socket: ChannelSocket,
    _signal: AbortSignal,
  ): Promise<void> => {
    socket.send(
      encodeRuntimeStatusEvent({
        kind: RUNTIME_STATUS_KIND,
        online: this.hasOnlineDaemon(),
        runtimeId: this.#runtimeId,
      }),
    );
    return Promise.resolve();
  };

  readonly detachDaemon = async (
    socket: ChannelSocket,
    signal: AbortSignal,
  ): Promise<void> => {
    const anotherDaemonOnline = this.#peers
      .daemons()
      .some((candidate) => !candidate.isSame(socket) && candidate.isOpen());
    if (anotherDaemonOnline) {
      return;
    }
    await this.#runtime.markRuntimeDisconnected(
      this.#scope,
      this.#runtimeId,
      this.#clock.now(),
      signal,
    );
    this.broadcastRuntimeStatus(false);
  };

  readonly receiveDaemonMessage = async (
    socket: ChannelSocket,
    message: unknown,
    signal: AbortSignal,
  ): Promise<void> => {
    if (typeof message !== "string" || message.length > 8 * 1024 * 1024) {
      socket.close(1003, "Bounded text message required");
      return;
    }
    try {
      const kind = decodeMessageKind(message);
      if (kind === SESSION_EVENT_KIND) {
        const envelope = decodeSessionEventEnvelope(message);
        const result = await this.#runtime.commitEvent(
          this.#scope,
          this.#runtimeId,
          envelope,
          this.#clock.now(),
          signal,
        );
        socket.send(
          encodeSessionEventAcknowledgement({
            cursor: result.committed.cursor,
            duplicate: result.duplicate,
            eventId: result.committed.eventId,
            kind: SESSION_EVENT_ACK_KIND,
            sequence: result.committed.sequence,
            sessionId: result.committed.sessionId,
          }),
        );
        if (!result.duplicate) {
          this.broadcast(
            this.#peers.hosts(),
            encodeCommittedSessionEvent(result.committed),
          );
        }
        return;
      }
      if (kind === NATIVE_SESSION_RESULT_KIND) {
        const result = decodeNativeSessionResult(message);
        let forwardedMessage = message;
        if (result.action === "import" || result.action === "fork") {
          const target = await this.#runtime.readSession(
            this.#scope,
            result.targetSessionId,
            signal,
          );
          if (
            target.runtimeId !== this.#runtimeId ||
            target.agentId !== result.ready.agentId ||
            target.defaultBinding.workspaceRef !== result.ready.directoryId
          )
            throw new ProtocolMessageError(
              "The native session result resolved to a different binding",
            );
          if (result.ready.sessionId !== result.targetSessionId) {
            const existing = await this.#runtime.readSession(
              this.#scope,
              result.ready.sessionId,
              signal,
            );
            if (
              existing.runtimeId !== this.#runtimeId ||
              existing.agentId !== result.ready.agentId
            )
              throw new ProtocolMessageError(
                "The native session result resolved to a different binding",
              );
            await this.#runtime.deleteSession(
              this.#scope,
              result.targetSessionId,
              this.#clock.now(),
              signal,
            );
          }
          const messages = await this.#runtime.readMessages(
            this.#scope,
            result.ready.sessionId,
            null,
            100,
            signal,
          );
          const history = reconcileNativeHistoryCoverage(
            result.history,
            messages.messages,
          );
          await this.#runtime.recordNativeHistory(
            this.#scope,
            this.#runtimeId,
            result.ready.sessionId,
            result.title,
            history,
            this.#clock.now(),
            signal,
          );
          forwardedMessage = encodeNativeSessionResult({
            ...result,
            history,
          });
        } else if (result.action === "preview") {
          await this.#runtime.deleteSession(
            this.#scope,
            result.targetSessionId,
            this.#clock.now(),
            signal,
          );
        }
        this.broadcast(this.#peers.hosts(), forwardedMessage);
        return;
      }
      this.validateDaemonControl(kind, message);
      this.broadcast(this.#peers.hosts(), message);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof SessionRuntimeError) {
        socket.close(sessionErrorCloseCode(error), error.code);
        return;
      }
      socket.close(
        error instanceof ProtocolMessageError ? 1008 : 1011,
        error instanceof ProtocolMessageError
          ? "Invalid protocol message"
          : "Session storage unavailable",
      );
    }
  };

  readonly receiveHostMessage = async (
    socket: ChannelSocket,
    message: unknown,
    signal: AbortSignal,
  ): Promise<void> => {
    if (typeof message !== "string" || message.length > 8 * 1024 * 1024) {
      socket.close(1003, "Bounded text message required");
      return;
    }
    try {
      const kind = decodeMessageKind(message);
      if (kind === SESSION_PROMPT_KIND) {
        const command = decodeSessionPromptCommand(message);
        if (!this.hasOnlineDaemon()) {
          socket.send(
            encodeSessionFailedEvent({
              code: "runtime_offline",
              commandId: command.commandId,
              kind: SESSION_FAILED_KIND,
              message:
                "The local runtime is offline; the command was not accepted",
              sessionId: command.sessionId,
            }),
          );
          return;
        }
        let acceptance: Awaited<ReturnType<SessionRuntime["acceptTurn"]>>;
        try {
          acceptance = await this.#runtime.acceptTurn(
            this.#scope,
            this.#runtimeId,
            command,
            this.#clock.now(),
            signal,
          );
        } catch (error) {
          if (error instanceof SessionRuntimeError) {
            socket.send(
              encodeSessionFailedEvent({
                code: error.code,
                commandId: command.commandId,
                kind: SESSION_FAILED_KIND,
                message: error.message,
                sessionId: command.sessionId,
              }),
            );
            return;
          }
          throw error;
        }
        if (acceptance.kind === "duplicate") {
          socket.send(
            encodeSessionFailedEvent({
              code: `duplicate_${acceptance.state}`,
              commandId: command.commandId,
              kind: SESSION_FAILED_KIND,
              message:
                "The command was already accepted and was not executed again",
              sessionId: command.sessionId,
            }),
          );
          return;
        }
        if (!this.sendToDaemon(message)) {
          socket.send(
            encodeSessionFailedEvent({
              code: "runtime_offline",
              commandId: command.commandId,
              kind: SESSION_FAILED_KIND,
              message:
                "The local runtime disconnected before the accepted command could be forwarded",
              sessionId: command.sessionId,
            }),
          );
          return;
        }
        await this.#runtime.markPendingWorkCompleted(
          this.#scope,
          command.sessionId,
          acceptance.pendingWork.workId,
          this.#clock.now(),
          signal,
        );
        this.broadcast(this.#peers.hosts(), message);
        return;
      }
      if (kind === SESSION_PREPARE_KIND) {
        const command = decodeSessionPrepareCommand(message);
        const now = this.#clock.now();
        try {
          await this.#runtime.createSession(
            this.#scope,
            new CreateSessionRequest(
              command.sessionId,
              this.#runtimeId,
              command.agentId,
              command.bindingId,
              command.directoryId,
              new SessionRecordingPolicy(
                "full",
                DEFAULT_RETENTION_MILLISECONDS,
                1_000,
                6_000_000,
              ),
            ),
            now,
            signal,
          );
        } catch (error) {
          if (
            !(error instanceof SessionRuntimeError) ||
            error.code !== "session_conflict"
          ) {
            throw error;
          }
          const existing = await this.#runtime.readSession(
            this.#scope,
            command.sessionId,
            signal,
          );
          if (
            existing.defaultBinding.bindingId !== command.bindingId ||
            existing.defaultBinding.runtimeId !== this.#runtimeId ||
            existing.defaultBinding.agentRef !== command.agentId ||
            existing.defaultBinding.workspaceRef !== command.directoryId
          ) {
            await this.#runtime.setDefaultBinding(
              this.#scope,
              command.sessionId,
              new CreateSessionBindingRequest(
                command.bindingId,
                this.#runtimeId,
                command.agentId,
                command.directoryId,
              ),
              now,
              signal,
            );
          }
        }
        this.forwardControl(
          socket,
          message,
          command.requestId,
          command.sessionId,
        );
        return;
      }
      if (kind === NATIVE_SESSION_REQUEST_KIND) {
        const command = decodeNativeSessionCommand(message);
        if (command.action === "import" || command.action === "fork") {
          await this.#runtime.createSession(
            this.#scope,
            new CreateSessionRequest(
              command.targetSessionId,
              this.#runtimeId,
              command.agentId,
              command.bindingId,
              command.directoryId,
              new SessionRecordingPolicy(
                "full",
                DEFAULT_RETENTION_MILLISECONDS,
                1_000,
                6_000_000,
              ),
            ),
            this.#clock.now(),
            signal,
          );
        }
        this.forwardControl(
          socket,
          message,
          command.requestId,
          command.sessionId,
        );
        return;
      }
      if (kind === SESSION_PERMISSION_RESPOND_KIND) {
        const command = decodeSessionPermissionRespondCommand(message);
        try {
          await this.acceptAndDeliverInteractionResponse(
            command.sessionId,
            command.interactionId,
            {
              content: JSON.stringify({
                optionId: command.optionId,
                outcome: command.outcome,
              }),
              kind: "permission",
            },
            message,
            signal,
          );
        } catch (error) {
          if (
            this.sendInteractionFailure(
              socket,
              command.sessionId,
              command.interactionId,
              error,
            )
          ) {
            return;
          }
          throw error;
        }
        this.broadcast(this.#peers.hosts(), message);
        return;
      }
      if (kind === SESSION_ELICITATION_RESPOND_KIND) {
        const command = decodeSessionElicitationRespondCommand(message);
        try {
          await this.acceptAndDeliverInteractionResponse(
            command.sessionId,
            command.interactionId,
            {
              content: JSON.stringify({
                action: command.action,
                content: command.content,
              }),
              kind: "elicitation",
            },
            message,
            signal,
          );
        } catch (error) {
          if (
            this.sendInteractionFailure(
              socket,
              command.sessionId,
              command.interactionId,
              error,
            )
          ) {
            return;
          }
          throw error;
        }
        this.broadcast(this.#peers.hosts(), message);
        return;
      }
      const control = this.validateHostControl(kind, message);
      this.forwardControl(
        socket,
        message,
        control.requestId,
        control.sessionId,
      );
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof SessionRuntimeError) {
        socket.close(sessionErrorCloseCode(error), error.code);
        return;
      }
      socket.close(1008, "Invalid protocol message");
    }
  };

  private readonly validateDaemonControl = (
    kind: string,
    message: string,
  ): void => {
    switch (kind) {
      case NATIVE_SESSION_RESULT_KIND:
        decodeNativeSessionResult(message);
        return;
      case WORKSPACE_ENTRIES_KIND:
        decodeWorkspaceEntriesEvent(message);
        return;
      case SESSION_OPERATION_FAILED_KIND:
        decodeSessionOperationFailedEvent(message);
        return;
      case AGENT_INSTALL_AWAITING_APPROVAL_KIND:
        decodeAgentInstallAwaitingApprovalEvent(message);
        return;
      case AGENT_INSTALL_STARTED_KIND:
        decodeAgentInstallStartedEvent(message);
        return;
      case AGENT_INSTALL_PROGRESS_KIND:
        decodeAgentInstallProgressEvent(message);
        return;
      case AGENT_INSTALL_COMPLETED_KIND:
        decodeAgentInstallCompletedEvent(message);
        return;
      case AGENT_INSTALL_FAILED_KIND:
        decodeAgentInstallFailedEvent(message);
        return;
      case AGENT_INSTALL_CANCELLED_KIND:
        decodeAgentInstallCancelledEvent(message);
        return;
      default:
        throw new ProtocolMessageError("Unsupported daemon message");
    }
  };

  private readonly validateHostControl = (
    kind: string,
    message: string,
  ): { readonly requestId: string; readonly sessionId: string } => {
    switch (kind) {
      case NATIVE_SESSION_REQUEST_KIND: {
        const command = decodeNativeSessionCommand(message);
        return { requestId: command.requestId, sessionId: command.sessionId };
      }
      case NATIVE_SESSION_CANCEL_KIND: {
        const command = decodeNativeSessionCancel(message);
        return { requestId: command.requestId, sessionId: command.sessionId };
      }
      case SESSION_CANCEL_KIND: {
        const command = decodeSessionCancelCommand(message);
        return { requestId: command.commandId, sessionId: command.sessionId };
      }
      case WORKSPACE_LIST_KIND: {
        const command = decodeWorkspaceListCommand(message);
        return { requestId: command.requestId, sessionId: "" };
      }
      case SESSION_CONFIGURE_KIND: {
        const command = decodeSessionConfigureCommand(message);
        return { requestId: command.requestId, sessionId: command.sessionId };
      }
      case SESSION_PERMISSION_RESPOND_KIND: {
        const command = decodeSessionPermissionRespondCommand(message);
        return {
          requestId: command.interactionId,
          sessionId: command.sessionId,
        };
      }
      case SESSION_ELICITATION_RESPOND_KIND: {
        const command = decodeSessionElicitationRespondCommand(message);
        return {
          requestId: command.interactionId,
          sessionId: command.sessionId,
        };
      }
      case AGENT_INSTALL_REQUEST_KIND: {
        const command = decodeAgentInstallRequestCommand(message);
        return { requestId: command.requestId, sessionId: "" };
      }
      case AGENT_INSTALL_CANCEL_KIND: {
        const command = decodeAgentInstallCancelCommand(message);
        return { requestId: command.requestId, sessionId: "" };
      }
      default:
        throw new ProtocolMessageError("Unsupported host message");
    }
  };

  private readonly forwardControl = (
    socket: ChannelSocket,
    message: string,
    requestId: string,
    sessionId: string,
  ): void => {
    if (!this.sendToDaemon(message)) {
      socket.send(
        encodeSessionFailedEvent({
          code: "runtime_offline",
          commandId: requestId,
          kind: SESSION_FAILED_KIND,
          message: "The local runtime is offline",
          sessionId: sessionId.length === 0 ? "runtime" : sessionId,
        }),
      );
      return;
    }
    this.broadcast(this.#peers.hosts(), message);
  };

  private readonly sendToDaemon = (message: string): boolean => {
    const daemon = this.#peers.daemons().find((socket) => socket.isOpen());
    if (daemon === undefined) {
      return false;
    }
    daemon.send(message);
    return true;
  };

  private readonly acceptAndDeliverInteractionResponse = async (
    sessionId: string,
    interactionId: string,
    response: Readonly<{
      content: string;
      kind: "elicitation" | "permission";
    }>,
    payload: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const accepted = await this.#runtime.acceptInteractionResponse(
      this.#scope,
      sessionId,
      interactionId,
      "project-client",
      response,
      payload,
      this.#clock.now(),
      signal,
    );
    if (accepted.pendingWork.state.kind === "completed") {
      return;
    }
    if (!this.sendToDaemon(payload)) {
      return;
    }
    await this.#runtime.markPendingWorkCompleted(
      this.#scope,
      sessionId,
      accepted.pendingWork.workId,
      this.#clock.now(),
      signal,
    );
  };

  private readonly sendInteractionFailure = (
    socket: ChannelSocket,
    sessionId: string,
    interactionId: string,
    error: unknown,
  ): boolean => {
    if (!(error instanceof SessionRuntimeError)) {
      return false;
    }
    socket.send(
      encodeSessionOperationFailedEvent({
        code: error.code,
        kind: SESSION_OPERATION_FAILED_KIND,
        message: error.message,
        requestId: interactionId,
        sessionId,
      }),
    );
    return true;
  };

  private readonly deliverPendingDaemonWork = async (
    signal: AbortSignal,
  ): Promise<void> => {
    let delivered = 0;
    while (delivered < 500) {
      const batch = await this.#runtime.listPendingDaemonDeliveries(
        this.#scope,
        this.#runtimeId,
        Math.min(100, 500 - delivered),
        signal,
      );
      if (batch.length === 0) {
        return;
      }
      for (const delivery of batch) {
        signal.throwIfAborted();
        if (!this.sendToDaemon(delivery.payload)) {
          return;
        }
        await this.#runtime.markPendingWorkCompleted(
          this.#scope,
          delivery.pendingWork.sessionId,
          delivery.pendingWork.workId,
          this.#clock.now(),
          signal,
        );
        delivered += 1;
      }
      if (batch.length < 100) {
        return;
      }
    }
  };

  private readonly hasOnlineDaemon = (): boolean =>
    this.#peers.daemons().some((socket) => socket.isOpen());

  private readonly broadcastRuntimeStatus = (online: boolean): void => {
    this.broadcast(
      this.#peers.hosts(),
      encodeRuntimeStatusEvent({
        kind: RUNTIME_STATUS_KIND,
        online,
        runtimeId: this.#runtimeId,
      }),
    );
  };

  private readonly broadcast = (
    sockets: readonly ChannelSocket[],
    message: string,
  ): void => {
    for (const socket of sockets) {
      if (socket.isOpen()) {
        socket.send(message);
      }
    }
  };
}
