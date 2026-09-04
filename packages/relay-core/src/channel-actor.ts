import {
  AGENT_ACTIVITY_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  decodeAgentActivityEvent,
  decodeAgentMessageDeltaEvent,
  decodeMessageKind,
  decodeSessionCancelCommand,
  decodeSessionCompletedEvent,
  decodeSessionFailedEvent,
  decodeSessionPromptCommand,
  decodeSessionStartedEvent,
  encodeRuntimeStatusEvent,
  encodeSessionFailedEvent,
  MOBIUS_PROTOCOL_VERSION,
  RUNTIME_STATUS_KIND,
  SESSION_CANCEL_KIND,
  SESSION_COMPLETED_KIND,
  SESSION_FAILED_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
  type SessionFailedEvent,
} from "@moxt-ai/mobius-protocol";

import { ChannelHistory, type ChannelTurnStore } from "./channel-turn-store.ts";

const MAX_MESSAGE_LENGTH = 128 * 1024;

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
  private readonly turnStore: ChannelTurnStore;

  constructor(
    runtimeId: string,
    turnStore: ChannelTurnStore,
    peers: ChannelPeers,
    clock: RelayClock = new SystemRelayClock(),
  ) {
    this.clock = clock;
    this.peers = peers;
    this.runtimeId = runtimeId;
    this.turnStore = turnStore;
  }

  readonly attachDaemon = (): void => {
    this.broadcastRuntimeStatus(true);
  };

  readonly attachHost = (socket: ChannelSocket): void => {
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
      this.broadcastRuntimeStatus(false);
    }
  };

  readonly readHistory = (): ChannelHistory =>
    new ChannelHistory(this.runtimeId, this.turnStore.readTurns());

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
      throw new Error("Unsupported host message");
    } catch {
      socket.close(1008, "Invalid protocol message");
    }
  };

  private receivePrompt(message: string): void {
    const command = decodeSessionPromptCommand(message);
    this.turnStore.recordPrompt(command, this.clock.now());
    this.broadcast(this.peers.hosts(), message);

    if (this.forwardToDaemon(message)) {
      return;
    }

    this.reportRuntimeOffline(command.commandId, command.sessionId);
  }

  private receiveCancellation(message: string): void {
    const command = decodeSessionCancelCommand(message);
    this.broadcast(this.peers.hosts(), message);

    if (this.forwardToDaemon(message)) {
      return;
    }

    this.reportRuntimeOffline(command.commandId, command.sessionId);
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
    if (kind === SESSION_COMPLETED_KIND) {
      this.turnStore.complete(decodeSessionCompletedEvent(message), now);
      return;
    }
    if (kind === SESSION_FAILED_KIND) {
      this.turnStore.fail(decodeSessionFailedEvent(message), now);
      return;
    }
    throw new Error("Unsupported daemon message");
  }
}
