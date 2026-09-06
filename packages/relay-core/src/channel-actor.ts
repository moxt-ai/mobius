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
  encodeRuntimeStatusEvent,
  encodeSessionEventAcknowledgement,
  encodeSessionFailedEvent,
  MOBIUS_PROTOCOL_VERSION,
  NATIVE_SESSION_CANCEL_KIND,
  NATIVE_SESSION_REQUEST_KIND,
  NATIVE_SESSION_RESULT_KIND,
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
  CreateSessionRequest,
  type ProjectScope,
  SessionRecordingPolicy,
  type SessionRuntime,
  SessionRuntimeError,
} from "./session-runtime.ts";

const DEFAULT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

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

  readonly attachDaemon = async (signal: AbortSignal): Promise<void> => {
    if (this.#peers.daemons().some((socket) => socket.isOpen())) {
      await this.#runtime.markRuntimeDisconnected(
        this.#scope,
        this.#runtimeId,
        this.#clock.now(),
        signal,
      );
    }
    this.broadcastRuntimeStatus(true);
  };

  readonly attachHost = (
    socket: ChannelSocket,
    _signal: AbortSignal,
  ): Promise<void> => {
    socket.send(
      encodeRuntimeStatusEvent({
        kind: RUNTIME_STATUS_KIND,
        online: this.hasOnlineDaemon(),
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
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
            protocolVersion: MOBIUS_PROTOCOL_VERSION,
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
        if (
          result.action === "preview" ||
          ((result.action === "import" || result.action === "fork") &&
            result.ready.sessionId !== result.targetSessionId)
        ) {
          await this.#runtime.deleteSession(
            this.#scope,
            result.targetSessionId,
            this.#clock.now(),
            signal,
          );
        }
        this.broadcast(this.#peers.hosts(), message);
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
              protocolVersion: MOBIUS_PROTOCOL_VERSION,
              sessionId: command.sessionId,
            }),
          );
          return;
        }
        const acceptance = await this.#runtime.acceptCommand(
          this.#scope,
          this.#runtimeId,
          command,
          this.#clock.now(),
          signal,
        );
        if (acceptance.kind === "duplicate") {
          socket.send(
            encodeSessionFailedEvent({
              code: `duplicate_${acceptance.state}`,
              commandId: command.commandId,
              kind: SESSION_FAILED_KIND,
              message:
                "The command was already accepted and was not executed again",
              protocolVersion: MOBIUS_PROTOCOL_VERSION,
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
              protocolVersion: MOBIUS_PROTOCOL_VERSION,
              sessionId: command.sessionId,
            }),
          );
          return;
        }
        this.broadcast(this.#peers.hosts(), message);
        return;
      }
      if (kind === SESSION_PREPARE_KIND) {
        const command = decodeSessionPrepareCommand(message);
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
          this.#clock.now(),
          signal,
        );
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
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
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

  private readonly hasOnlineDaemon = (): boolean =>
    this.#peers.daemons().some((socket) => socket.isOpen());

  private readonly broadcastRuntimeStatus = (online: boolean): void => {
    this.broadcast(
      this.#peers.hosts(),
      encodeRuntimeStatusEvent({
        kind: RUNTIME_STATUS_KIND,
        online,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
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
