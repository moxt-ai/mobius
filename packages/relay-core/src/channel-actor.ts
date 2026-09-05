import {
  AGENT_ACTIVITY_KIND,
  AGENT_CONTENT_KIND,
  AGENT_INSTALL_AWAITING_APPROVAL_KIND,
  AGENT_INSTALL_CANCEL_KIND,
  AGENT_INSTALL_CANCELLED_KIND,
  AGENT_INSTALL_COMPLETED_KIND,
  AGENT_INSTALL_FAILED_KIND,
  AGENT_INSTALL_PROGRESS_KIND,
  AGENT_INSTALL_REQUEST_KIND,
  AGENT_INSTALL_STARTED_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  decodeAgentActivityEvent,
  decodeAgentContentEvent,
  decodeAgentInstallAwaitingApprovalEvent,
  decodeAgentInstallCancelCommand,
  decodeAgentInstallCancelledEvent,
  decodeAgentInstallCompletedEvent,
  decodeAgentInstallFailedEvent,
  decodeAgentInstallProgressEvent,
  decodeAgentInstallRequestCommand,
  decodeAgentInstallStartedEvent,
  decodeAgentMessageDeltaEvent,
  decodeMessageKind,
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
  encodeRuntimeStatusEvent,
  encodeSessionFailedEvent,
  encodeSessionOperationFailedEvent,
  MOBIUS_PROTOCOL_VERSION,
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
  type SessionFailedEvent,
  type SessionOperationFailedEvent,
  WORKSPACE_ENTRIES_KIND,
  WORKSPACE_LIST_KIND,
} from "@moxt-ai/mobius-protocol";
import {
  type ChannelSessionStore,
  MemoryChannelSessionStore,
} from "./channel-session-store.ts";
import { ChannelHistory, type ChannelTurnStore } from "./channel-turn-store.ts";

const MAX_MESSAGE_LENGTH = 8 * 1024 * 1024;
const DAEMON_START_TIMEOUT_MILLISECONDS = 15_000;

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
  private readonly clock: RelayClock;
  private readonly peers: ChannelPeers;
  private readonly runtimeId: string;
  private readonly sessionStore: ChannelSessionStore;
  private readonly turnStore: ChannelTurnStore;

  constructor(
    runtimeId: string,
    turnStore: ChannelTurnStore,
    peers: ChannelPeers,
    clock: RelayClock = new SystemRelayClock(),
    sessionStore: ChannelSessionStore = new MemoryChannelSessionStore(),
  ) {
    this.clock = clock;
    this.peers = peers;
    this.runtimeId = runtimeId;
    this.sessionStore = sessionStore;
    this.turnStore = turnStore;
  }

  readonly attachDaemon = (): void => {
    this.failActiveTurns(
      "daemon_reconnected",
      "The local runtime reconnected before this request finished. Send it again.",
    );
    this.broadcastRuntimeStatus(true);
  };

  readonly attachHost = (socket: ChannelSocket): void => {
    this.failExpiredPendingTurns();
    socket.send(
      encodeRuntimeStatusEvent({
        kind: RUNTIME_STATUS_KIND,
        online: this.hasOnlineDaemon(),
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        runtimeId: this.runtimeId,
      }),
    );
  };

  readonly detachDaemon = (socket: ChannelSocket): void => {
    const anotherDaemonOnline = this.peers
      .daemons()
      .some((candidate) => !candidate.isSame(socket) && candidate.isOpen());
    if (!anotherDaemonOnline) {
      this.failActiveTurns(
        "daemon_disconnected",
        "The local runtime disconnected before this request finished. Send it again.",
      );
      this.broadcastRuntimeStatus(false);
    }
  };

  readonly readHistory = (): ChannelHistory => {
    this.failExpiredPendingTurns();
    return new ChannelHistory(
      this.runtimeId,
      this.turnStore.readTurns(),
      this.sessionStore.readSessions(),
    );
  };

  readonly receiveDaemonMessage = (
    socket: ChannelSocket,
    message: unknown,
  ): void => {
    if (!this.isValidMessage(message)) {
      socket.close(1003, "Text message required");
      return;
    }

    try {
      this.recordDaemonMessage(message);
    } catch {
      socket.close(1008, "Invalid protocol message");
      return;
    }
    this.broadcast(this.peers.hosts(), message);
  };

  readonly receiveHostMessage = (
    socket: ChannelSocket,
    message: unknown,
  ): void => {
    if (!this.isValidMessage(message)) {
      socket.close(1003, "Text message required");
      return;
    }

    try {
      const kind = decodeMessageKind(message);
      if (kind === SESSION_PROMPT_KIND) {
        this.receivePrompt(message);
        return;
      }
      if (kind === SESSION_CANCEL_KIND) {
        this.receiveCancellation(message);
        return;
      }
      if (kind === WORKSPACE_LIST_KIND) {
        const command = decodeWorkspaceListCommand(message);
        this.receiveControl(message, command.requestId, "");
        return;
      }
      if (kind === SESSION_PREPARE_KIND) {
        const command = decodeSessionPrepareCommand(message);
        this.receiveControl(message, command.requestId, command.sessionId);
        return;
      }
      if (kind === SESSION_CONFIGURE_KIND) {
        const command = decodeSessionConfigureCommand(message);
        this.receiveControl(message, command.requestId, command.sessionId);
        return;
      }
      if (kind === SESSION_PERMISSION_RESPOND_KIND) {
        const command = decodeSessionPermissionRespondCommand(message);
        this.receiveControl(message, command.interactionId, command.sessionId);
        return;
      }
      if (kind === SESSION_ELICITATION_RESPOND_KIND) {
        const command = decodeSessionElicitationRespondCommand(message);
        this.receiveControl(message, command.interactionId, command.sessionId);
        return;
      }
      if (kind === AGENT_INSTALL_REQUEST_KIND) {
        const command = decodeAgentInstallRequestCommand(message);
        this.receiveControl(message, command.requestId, "");
        return;
      }
      if (kind === AGENT_INSTALL_CANCEL_KIND) {
        const command = decodeAgentInstallCancelCommand(message);
        this.receiveControl(message, command.requestId, "");
        return;
      }
      throw new Error("Unsupported host message");
    } catch {
      socket.close(1008, "Invalid protocol message");
    }
  };

  private receivePrompt(message: string): void {
    const command = decodeSessionPromptCommand(message);
    this.failExpiredPendingTurns();
    this.turnStore.recordPrompt(command, this.clock.now());
    this.broadcast(this.peers.hosts(), message);

    if (this.forwardToDaemon(message)) {
      return;
    }

    this.reportRuntimeOffline(command.commandId, command.sessionId);
  }

  private receiveCancellation(message: string): void {
    const command = decodeSessionCancelCommand(message);
    this.failExpiredPendingTurns();
    this.broadcast(this.peers.hosts(), message);

    if (this.forwardToDaemon(message)) {
      return;
    }

    this.reportRuntimeOffline(command.commandId, command.sessionId);
  }

  private receiveControl(
    message: string,
    requestId: string,
    sessionId: string,
  ): void {
    this.broadcast(this.peers.hosts(), message);
    if (this.forwardToDaemon(message)) {
      return;
    }
    const failure: SessionOperationFailedEvent = {
      code: "runtime_offline",
      kind: SESSION_OPERATION_FAILED_KIND,
      message: "The local runtime is offline",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId,
      sessionId,
    };
    this.broadcast(
      this.peers.hosts(),
      encodeSessionOperationFailedEvent(failure),
    );
  }

  private forwardToDaemon(message: string): boolean {
    for (const daemon of this.peers.daemons()) {
      if (daemon.isOpen()) {
        daemon.send(message);
        return true;
      }
    }
    return false;
  }

  private failActiveTurns(code: string, message: string): void {
    const failures = this.turnStore.failActive(code, message, this.clock.now());
    this.publishFailures(failures);
  }

  private failExpiredPendingTurns(): void {
    const now = this.clock.now();
    const failures = this.turnStore.failPendingBefore(
      now - DAEMON_START_TIMEOUT_MILLISECONDS,
      "daemon_start_timeout",
      "The local runtime did not acknowledge this request in time. Send it again.",
      now,
    );
    this.publishFailures(failures);
  }

  private publishFailures(failures: readonly SessionFailedEvent[]): void {
    this.sessionStore.clearInteractionsForCommands(
      failures.map((failure) => failure.commandId),
    );
    for (const failure of failures) {
      this.broadcast(this.peers.hosts(), encodeSessionFailedEvent(failure));
    }
  }

  private reportRuntimeOffline(commandId: string, sessionId: string): void {
    const failure: SessionFailedEvent = {
      code: "runtime_offline",
      commandId,
      kind: SESSION_FAILED_KIND,
      message: "The local runtime is offline",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId,
    };
    try {
      this.turnStore.fail(failure, this.clock.now());
    } catch {
      // A stale cancellation must not affect another or already-finished turn.
    }
    this.broadcast(this.peers.hosts(), encodeSessionFailedEvent(failure));
  }

  private broadcast(sockets: readonly ChannelSocket[], message: string): void {
    for (const socket of sockets) {
      if (socket.isOpen()) {
        socket.send(message);
      }
    }
  }

  private broadcastRuntimeStatus(online: boolean): void {
    this.broadcast(
      this.peers.hosts(),
      encodeRuntimeStatusEvent({
        kind: RUNTIME_STATUS_KIND,
        online,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        runtimeId: this.runtimeId,
      }),
    );
  }

  private hasOnlineDaemon(): boolean {
    return this.peers.daemons().some((socket) => socket.isOpen());
  }

  private isValidMessage(message: unknown): message is string {
    return typeof message === "string" && message.length <= MAX_MESSAGE_LENGTH;
  }

  private recordDaemonMessage(message: string): void {
    const kind = decodeMessageKind(message);
    const now = this.clock.now();
    if (kind === SESSION_STARTED_KIND) {
      this.turnStore.markStarted(decodeSessionStartedEvent(message), now);
      return;
    }
    if (kind === AGENT_MESSAGE_DELTA_KIND) {
      this.turnStore.appendDelta(decodeAgentMessageDeltaEvent(message), now);
      return;
    }
    if (kind === AGENT_ACTIVITY_KIND) {
      this.turnStore.recordActivity(decodeAgentActivityEvent(message), now);
      return;
    }
    if (kind === AGENT_CONTENT_KIND) {
      this.turnStore.recordContent(decodeAgentContentEvent(message), now);
      return;
    }
    if (kind === SESSION_COMPLETED_KIND) {
      this.turnStore.complete(decodeSessionCompletedEvent(message), now);
      return;
    }
    if (kind === SESSION_FAILED_KIND) {
      this.turnStore.fail(decodeSessionFailedEvent(message), now);
      return;
    }
    if (kind === SESSION_READY_KIND) {
      this.sessionStore.recordReady(decodeSessionReadyEvent(message));
      return;
    }
    if (kind === SESSION_CONFIG_UPDATED_KIND) {
      this.sessionStore.recordConfig(decodeSessionConfigUpdatedEvent(message));
      return;
    }
    if (kind === SESSION_COMMANDS_UPDATED_KIND) {
      this.sessionStore.recordCommands(
        decodeSessionCommandsUpdatedEvent(message),
      );
      return;
    }
    if (kind === SESSION_INFO_UPDATED_KIND) {
      this.sessionStore.recordInfo(decodeSessionInfoUpdatedEvent(message));
      return;
    }
    if (kind === SESSION_USAGE_UPDATED_KIND) {
      this.sessionStore.recordUsage(decodeSessionUsageUpdatedEvent(message));
      return;
    }
    if (kind === SESSION_PERMISSION_REQUESTED_KIND) {
      this.sessionStore.recordPermission(
        decodeSessionPermissionRequestedEvent(message),
      );
      return;
    }
    if (kind === SESSION_PERMISSION_RESOLVED_KIND) {
      this.sessionStore.resolvePermission(
        decodeSessionPermissionResolvedEvent(message),
      );
      return;
    }
    if (kind === SESSION_ELICITATION_REQUESTED_KIND) {
      this.sessionStore.recordElicitation(
        decodeSessionElicitationRequestedEvent(message),
      );
      return;
    }
    if (kind === SESSION_ELICITATION_RESOLVED_KIND) {
      this.sessionStore.resolveElicitation(
        decodeSessionElicitationResolvedEvent(message),
      );
      return;
    }
    if (kind === WORKSPACE_ENTRIES_KIND) {
      decodeWorkspaceEntriesEvent(message);
      return;
    }
    if (kind === SESSION_OPERATION_FAILED_KIND) {
      decodeSessionOperationFailedEvent(message);
      return;
    }
    if (kind === AGENT_INSTALL_AWAITING_APPROVAL_KIND) {
      decodeAgentInstallAwaitingApprovalEvent(message);
      return;
    }
    if (kind === AGENT_INSTALL_STARTED_KIND) {
      decodeAgentInstallStartedEvent(message);
      return;
    }
    if (kind === AGENT_INSTALL_PROGRESS_KIND) {
      decodeAgentInstallProgressEvent(message);
      return;
    }
    if (kind === AGENT_INSTALL_COMPLETED_KIND) {
      decodeAgentInstallCompletedEvent(message);
      return;
    }
    if (kind === AGENT_INSTALL_FAILED_KIND) {
      decodeAgentInstallFailedEvent(message);
      return;
    }
    if (kind === AGENT_INSTALL_CANCELLED_KIND) {
      decodeAgentInstallCancelledEvent(message);
      return;
    }
    throw new Error("Unsupported daemon message");
  }
}
