import {
  AGENT_ACTIVITY_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  type AgentActivityEvent,
  type AgentMessageDeltaEvent,
  decodeSessionCancelCommand,
  encodeAgentActivityEvent,
  encodeAgentMessageDeltaEvent,
  encodeSessionCancelCommand,
  encodeSessionCompletedEvent,
  encodeSessionPromptCommand,
  encodeSessionStartedEvent,
  MOBIUS_PROTOCOL_VERSION,
  SESSION_CANCEL_KIND,
  SESSION_COMPLETED_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
  type SessionCancelCommand,
  type SessionCompletedEvent,
  type SessionFailedEvent,
  type SessionPromptCommand,
  type SessionStartedEvent,
} from "@moxt-ai/mobius-protocol";
import { describe, expect, it } from "vitest";

import {
  ChannelActor,
  type ChannelPeers,
  type ChannelSocket,
  type ChannelTurnStore,
  CompletedRecordedTurn,
  FailedRecordedTurn,
  PendingRecordedTurn,
  RecordedActivity,
  type RecordedTurn,
  type RelayClock,
  RunningRecordedTurn,
} from "../src/index.ts";

class FixedClock implements RelayClock {
  readonly now = (): number => 1_700_000_000_000;
}

class MemorySocket implements ChannelSocket {
  readonly messages: string[] = [];
  private open = true;

  readonly close = (): void => {
    this.open = false;
  };

  readonly isOpen = (): boolean => this.open;

  readonly isSame = (socket: ChannelSocket): boolean => socket === this;

  readonly send = (message: string): void => {
    this.messages.push(message);
  };
}

class MemoryPeers implements ChannelPeers {
  readonly daemonSockets: MemorySocket[] = [];
  readonly hostSockets: MemorySocket[] = [];

  readonly daemons = (): readonly ChannelSocket[] => this.daemonSockets;

  readonly hosts = (): readonly ChannelSocket[] => this.hostSockets;
}

class MemoryTurnStore implements ChannelTurnStore {
  readonly activityEvents: AgentActivityEvent[] = [];
  private readonly turns = new Map<string, RecordedTurn>();

  readonly appendDelta = (event: AgentMessageDeltaEvent): void => {
    const turn = this.requireRunning(event.commandId, event.sessionId);
    this.turns.set(
      event.commandId,
      new RunningRecordedTurn(
        turn.agentId,
        turn.commandId,
        turn.createdAt,
        turn.prompt,
        turn.response + event.text,
        turn.sessionId,
        turn.processAttemptId,
        turn.activities,
      ),
    );
  };

  readonly complete = (event: SessionCompletedEvent): void => {
    const turn = this.requireRunning(event.commandId, event.sessionId);
    this.turns.set(
      event.commandId,
      new CompletedRecordedTurn(
        turn.agentId,
        turn.commandId,
        turn.createdAt,
        turn.prompt,
        turn.response,
        turn.sessionId,
        turn.processAttemptId,
        event.stopReason,
        turn.activities,
      ),
    );
  };

  readonly fail = (event: SessionFailedEvent): void => {
    const turn = this.requireTurn(event.commandId, event.sessionId);
    this.turns.set(
      event.commandId,
      new FailedRecordedTurn(
        turn.agentId,
        turn.commandId,
        turn.createdAt,
        turn.prompt,
        turn.response,
        turn.sessionId,
        event.code,
        event.message,
        turn.activities,
      ),
    );
  };

  readonly markStarted = (event: SessionStartedEvent): void => {
    const turn = this.requireTurn(event.commandId, event.sessionId);
    if (!(turn instanceof PendingRecordedTurn)) {
      throw new Error("The turn is not pending");
    }
    this.turns.set(
      event.commandId,
      new RunningRecordedTurn(
        turn.agentId,
        turn.commandId,
        turn.createdAt,
        turn.prompt,
        turn.response,
        turn.sessionId,
        event.processAttemptId,
        turn.activities,
      ),
    );
  };

  readonly recordActivity = (event: AgentActivityEvent): void => {
    const turn = this.requireRunning(event.commandId, event.sessionId);
    const activity = RecordedActivity.fromEvent(event);
    const activities = turn.activities.filter(
      (candidate) => candidate.activityId !== activity.activityId,
    );
    activities.push(activity);
    activities.sort((left, right) => left.sequence - right.sequence);
    this.turns.set(
      event.commandId,
      new RunningRecordedTurn(
        turn.agentId,
        turn.commandId,
        turn.createdAt,
        turn.prompt,
        turn.response,
        turn.sessionId,
        turn.processAttemptId,
        activities,
      ),
    );
    this.activityEvents.push(event);
  };

  readonly readTurns = (): readonly RecordedTurn[] => [...this.turns.values()];

  readonly recordPrompt = (
    command: SessionPromptCommand,
    now: number,
  ): void => {
    if (this.turns.has(command.commandId)) {
      throw new Error("The command already exists");
    }
    this.turns.set(
      command.commandId,
      new PendingRecordedTurn(
        command.agentId,
        command.commandId,
        new Date(now).toISOString(),
        command.prompt,
        "",
        command.sessionId,
      ),
    );
  };

  private requireRunning(
    commandId: string,
    sessionId: string,
  ): RunningRecordedTurn {
    const turn = this.requireTurn(commandId, sessionId);
    if (!(turn instanceof RunningRecordedTurn)) {
      throw new Error("The turn is not running");
    }
    return turn;
  }

  private requireTurn(commandId: string, sessionId: string): RecordedTurn {
    const turn = this.turns.get(commandId);
    if (turn === undefined || turn.sessionId !== sessionId) {
      throw new Error("The turn does not exist");
    }
    return turn;
  }
}

describe("channel actor", () => {
  it("Given runtime-neutral peers and storage, When a turn streams, Then every peer observes one persistent lifecycle", () => {
    const peers = new MemoryPeers();
    const store = new MemoryTurnStore();
    const actor = new ChannelActor("channel-1", store, peers, new FixedClock());
    const sendingHost = new MemorySocket();
    const observingHost = new MemorySocket();
    const daemon = new MemorySocket();
    peers.hostSockets.push(sendingHost, observingHost);
    peers.daemonSockets.push(daemon);

    actor.attachHost(sendingHost);
    actor.attachDaemon();

    const prompt = encodeSessionPromptCommand({
      agentId: "codex",
      bindingId: "workspace",
      commandId: "command-1",
      kind: SESSION_PROMPT_KIND,
      prompt: "hello",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
    });
    actor.receiveHostMessage(sendingHost, prompt);
    expect(daemon.messages.at(-1)).toBe(prompt);
    expect(observingHost.messages.at(-1)).toBe(prompt);
    expect(actor.readHistory()).toMatchObject({
      runtimeId: "channel-1",
      turns: [{ commandId: "command-1", status: "pending" }],
    });

    const started = encodeSessionStartedEvent({
      commandId: "command-1",
      kind: SESSION_STARTED_KIND,
      processAttemptId: "attempt-1",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
    });
    actor.receiveDaemonMessage(daemon, started);
    const delta = encodeAgentMessageDeltaEvent({
      commandId: "command-1",
      kind: AGENT_MESSAGE_DELTA_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
      text: "world",
    });
    actor.receiveDaemonMessage(daemon, delta);
    const activity = encodeAgentActivityEvent({
      activityId: "tool-1",
      activityType: "tool",
      commandId: "command-1",
      input: '{"path":"package.json"}',
      kind: AGENT_ACTIVITY_KIND,
      locations: ["/workspace/package.json"],
      name: "read_file",
      output: "package metadata",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sequence: 0,
      sessionId: "session-1",
      status: "completed",
      title: "Read package metadata",
      toolKind: "read",
    });
    actor.receiveDaemonMessage(daemon, activity);
    const completed = encodeSessionCompletedEvent({
      commandId: "command-1",
      kind: SESSION_COMPLETED_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
      stopReason: "end_turn",
    });
    actor.receiveDaemonMessage(daemon, completed);

    expect(sendingHost.messages.slice(-4)).toEqual([
      started,
      delta,
      activity,
      completed,
    ]);
    expect(observingHost.messages.slice(-4)).toEqual([
      started,
      delta,
      activity,
      completed,
    ]);
    expect(store.activityEvents).toMatchObject([
      {
        activityId: "tool-1",
        status: "completed",
        title: "Read package metadata",
      },
    ]);
    expect(actor.readHistory()).toMatchObject({
      runtimeId: "channel-1",
      turns: [
        {
          commandId: "command-1",
          processAttemptId: "attempt-1",
          response: "world",
          status: "completed",
          stopReason: "end_turn",
          activities: [
            {
              activityId: "tool-1",
              status: "completed",
              title: "Read package metadata",
            },
          ],
        },
      ],
    });

    actor.detachDaemon(daemon);
    expect(sendingHost.messages.at(-1)).toContain('"online":false');
    expect(observingHost.messages.at(-1)).toContain('"online":false');
  });

  it("Given a running turn, When a host requests cancellation, Then the exact command is forwarded to the local daemon and observers", () => {
    const peers = new MemoryPeers();
    const store = new MemoryTurnStore();
    const actor = new ChannelActor("channel-1", store, peers, new FixedClock());
    const sendingHost = new MemorySocket();
    const observingHost = new MemorySocket();
    const daemon = new MemorySocket();
    peers.hostSockets.push(sendingHost, observingHost);
    peers.daemonSockets.push(daemon);

    const prompt = encodeSessionPromptCommand({
      agentId: "codex",
      bindingId: "workspace",
      commandId: "command-1",
      kind: SESSION_PROMPT_KIND,
      prompt: "long task",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
    });
    actor.receiveHostMessage(sendingHost, prompt);
    actor.receiveDaemonMessage(
      daemon,
      encodeSessionStartedEvent({
        commandId: "command-1",
        kind: SESSION_STARTED_KIND,
        processAttemptId: "attempt-1",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: "session-1",
      }),
    );
    const cancellation = encodeSessionCancelCommand({
      commandId: "command-1",
      kind: SESSION_CANCEL_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
    });

    actor.receiveHostMessage(sendingHost, cancellation);

    expect(
      decodeSessionCancelCommand(daemon.messages.at(-1) ?? ""),
    ).toMatchObject<SessionCancelCommand>({
      commandId: "command-1",
      kind: SESSION_CANCEL_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
    });
    expect(observingHost.messages.at(-1)).toBe(cancellation);
    expect(actor.readHistory()).toMatchObject({
      turns: [{ commandId: "command-1", status: "running" }],
    });
  });
});
