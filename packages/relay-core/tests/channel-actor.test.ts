import {
  AGENT_ACTIVITY_KIND,
  AGENT_CONTENT_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  type AgentActivityEvent,
  type AgentContentEvent,
  type AgentMessageDeltaEvent,
  decodeSessionCancelCommand,
  decodeSessionFailedEvent,
  encodeAgentActivityEvent,
  encodeAgentContentEvent,
  encodeAgentMessageDeltaEvent,
  encodeSessionCancelCommand,
  encodeSessionCompletedEvent,
  encodeSessionPermissionRequestedEvent,
  encodeSessionPrepareCommand,
  encodeSessionPromptCommand,
  encodeSessionReadyEvent,
  encodeSessionStartedEvent,
  encodeSessionUsageUpdatedEvent,
  MOBIUS_PROTOCOL_VERSION,
  SESSION_CANCEL_KIND,
  SESSION_COMPLETED_KIND,
  SESSION_PERMISSION_REQUESTED_KIND,
  SESSION_PREPARE_KIND,
  SESSION_PROMPT_KIND,
  SESSION_READY_KIND,
  SESSION_STARTED_KIND,
  SESSION_USAGE_UPDATED_KIND,
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
  RecordedContent,
  type RecordedTurn,
  type RelayClock,
  RunningRecordedTurn,
} from "../src/index.ts";

class FixedClock implements RelayClock {
  readonly now = (): number => 1_700_000_000_000;
}

class MutableClock implements RelayClock {
  #now = 1_700_000_000_000;

  readonly advance = (milliseconds: number): void => {
    this.#now += milliseconds;
  };

  readonly now = (): number => this.#now;
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
        turn.images,
        turn.resources,
        turn.contents,
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
        turn.images,
        turn.resources,
        turn.contents,
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
        turn.images,
        turn.resources,
        turn.contents,
      ),
    );
  };

  readonly failActive = (
    code: string,
    message: string,
  ): readonly SessionFailedEvent[] => {
    const failures: SessionFailedEvent[] = [];
    for (const turn of this.turns.values()) {
      if (
        !(turn instanceof PendingRecordedTurn) &&
        !(turn instanceof RunningRecordedTurn)
      ) {
        continue;
      }
      const failure: SessionFailedEvent = {
        code,
        commandId: turn.commandId,
        kind: "session.failed",
        message,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: turn.sessionId,
      };
      this.fail(failure);
      failures.push(failure);
    }
    return failures;
  };

  readonly failPendingBefore = (
    cutoff: number,
    code: string,
    message: string,
  ): readonly SessionFailedEvent[] => {
    const failures: SessionFailedEvent[] = [];
    for (const turn of this.turns.values()) {
      if (
        !(turn instanceof PendingRecordedTurn) ||
        Date.parse(turn.createdAt) > cutoff
      ) {
        continue;
      }
      const failure: SessionFailedEvent = {
        code,
        commandId: turn.commandId,
        kind: "session.failed",
        message,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: turn.sessionId,
      };
      this.fail(failure);
      failures.push(failure);
    }
    return failures;
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
        turn.images,
        turn.resources,
        turn.contents,
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
        turn.images,
        turn.resources,
        turn.contents,
      ),
    );
    this.activityEvents.push(event);
  };

  readonly readTurns = (): readonly RecordedTurn[] => [...this.turns.values()];

  readonly recordContent = (event: AgentContentEvent): void => {
    const turn = this.requireRunning(event.commandId, event.sessionId);
    const contents = turn.contents.filter(
      (candidate) => candidate.contentId !== event.contentId,
    );
    contents.push(RecordedContent.fromEvent(event));
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
        turn.activities,
        turn.images,
        turn.resources,
        contents,
      ),
    );
  };

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
        [],
        command.images,
        command.resources,
        [],
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
  it("Given a running turn is waiting for permission, When its only daemon disconnects, Then the conversation fails without leaving an interaction pending", () => {
    const peers = new MemoryPeers();
    const store = new MemoryTurnStore();
    const actor = new ChannelActor("channel-1", store, peers, new FixedClock());
    const host = new MemorySocket();
    const daemon = new MemorySocket();
    peers.hostSockets.push(host);
    peers.daemonSockets.push(daemon);
    actor.attachDaemon();
    actor.receiveDaemonMessage(
      daemon,
      encodeSessionReadyEvent({
        additionalDirectories: [],
        agentId: "codex",
        agentName: "Codex",
        agentVersion: "1.0.0",
        capabilities: {
          additionalDirectories: true,
          audioPrompt: false,
          closeSession: true,
          deleteSession: false,
          embeddedContextPrompt: true,
          imagePrompt: true,
          listSessions: false,
          loadSession: true,
          resumeSession: true,
        },
        commands: [],
        configOptions: [],
        directoryId: "root",
        directoryLabel: "mobius",
        kind: SESSION_READY_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        requestId: "prepare-1",
        restored: false,
        sessionId: "session-1",
      }),
    );
    actor.receiveHostMessage(
      host,
      encodeSessionPromptCommand({
        additionalDirectoryIds: [],
        agentId: "codex",
        bindingId: "workspace",
        commandId: "command-1",
        directoryId: "root",
        images: [],
        kind: SESSION_PROMPT_KIND,
        prompt: "run protected action",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        resources: [],
        sessionId: "session-1",
      }),
    );
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
    actor.receiveDaemonMessage(
      daemon,
      encodeSessionPermissionRequestedEvent({
        commandId: "command-1",
        interactionId: "permission-1",
        kind: SESSION_PERMISSION_REQUESTED_KIND,
        options: [
          {
            kind: "allow_once",
            name: "Allow once",
            optionId: "allow-once",
          },
        ],
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: "session-1",
        title: "Run protected action",
        toolCallId: "tool-1",
        toolKind: "execute",
      }),
    );

    daemon.close();
    actor.detachDaemon(daemon);

    expect(actor.readHistory()).toMatchObject({
      sessions: [
        {
          pendingElicitations: [],
          pendingPermissions: [],
          sessionId: "session-1",
        },
      ],
      turns: [
        {
          code: "daemon_disconnected",
          commandId: "command-1",
          status: "failed",
        },
      ],
    });
  });

  it("Given a turn remains unacknowledged, When a browser refreshes after the delivery deadline, Then the conversation shows a retryable failure", () => {
    const clock = new MutableClock();
    const peers = new MemoryPeers();
    const store = new MemoryTurnStore();
    const actor = new ChannelActor("channel-1", store, peers, clock);
    const host = new MemorySocket();
    const daemon = new MemorySocket();
    peers.hostSockets.push(host);
    peers.daemonSockets.push(daemon);
    actor.attachDaemon();
    actor.receiveHostMessage(
      host,
      encodeSessionPromptCommand({
        additionalDirectoryIds: [],
        agentId: "codex",
        bindingId: "workspace",
        commandId: "stalled-command",
        directoryId: "root",
        images: [],
        kind: SESSION_PROMPT_KIND,
        prompt: "stalled task",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        resources: [],
        sessionId: "session-1",
      }),
    );

    clock.advance(60_000);
    const history = actor.readHistory();

    expect(history.turns).toMatchObject([
      {
        code: "daemon_start_timeout",
        commandId: "stalled-command",
        status: "failed",
      },
    ]);
    expect(decodeSessionFailedEvent(host.messages.at(-1) ?? "")).toMatchObject({
      code: "daemon_start_timeout",
      commandId: "stalled-command",
      sessionId: "session-1",
    });
  });

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
      additionalDirectoryIds: [],
      agentId: "codex",
      bindingId: "workspace",
      commandId: "command-1",
      directoryId: "root",
      images: [],
      kind: SESSION_PROMPT_KIND,
      prompt: "hello",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      resources: [],
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
      content: [],
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
      additionalDirectoryIds: [],
      agentId: "codex",
      bindingId: "workspace",
      commandId: "command-1",
      directoryId: "root",
      images: [],
      kind: SESSION_PROMPT_KIND,
      prompt: "long task",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      resources: [],
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

  it("Given session control and rich ACP events, When they cross the relay, Then another browser can recover the complete session state", () => {
    const peers = new MemoryPeers();
    const store = new MemoryTurnStore();
    const actor = new ChannelActor("channel-1", store, peers, new FixedClock());
    const host = new MemorySocket();
    const daemon = new MemorySocket();
    peers.hostSockets.push(host);
    peers.daemonSockets.push(daemon);

    const prepare = encodeSessionPrepareCommand({
      additionalDirectoryIds: [],
      agentId: "codex",
      bindingId: "workspace",
      directoryId: "root",
      kind: SESSION_PREPARE_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: "prepare-1",
      sessionId: "session-1",
    });
    actor.receiveHostMessage(host, prepare);
    expect(daemon.messages.at(-1)).toBe(prepare);

    actor.receiveDaemonMessage(
      daemon,
      encodeSessionReadyEvent({
        additionalDirectories: [],
        agentId: "codex",
        agentName: "Codex",
        agentVersion: "1.0.0",
        capabilities: {
          additionalDirectories: true,
          audioPrompt: false,
          closeSession: true,
          deleteSession: false,
          embeddedContextPrompt: true,
          imagePrompt: true,
          listSessions: false,
          loadSession: true,
          resumeSession: true,
        },
        commands: [],
        configOptions: [],
        directoryId: "root",
        directoryLabel: "mobius",
        kind: SESSION_READY_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        requestId: "prepare-1",
        restored: false,
        sessionId: "session-1",
      }),
    );
    actor.receiveDaemonMessage(
      daemon,
      encodeSessionUsageUpdatedEvent({
        costAmount: 0.25,
        costCurrency: "USD",
        hasCost: true,
        kind: SESSION_USAGE_UPDATED_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: "session-1",
        size: 200_000,
        used: 50_000,
      }),
    );
    actor.receiveDaemonMessage(
      daemon,
      encodeSessionPermissionRequestedEvent({
        commandId: "command-1",
        interactionId: "permission-1",
        kind: SESSION_PERMISSION_REQUESTED_KIND,
        options: [
          {
            kind: "allow_once",
            name: "Allow once",
            optionId: "allow-once",
          },
        ],
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: "session-1",
        title: "Run checks",
        toolCallId: "tool-1",
        toolKind: "execute",
      }),
    );

    const prompt = encodeSessionPromptCommand({
      additionalDirectoryIds: [],
      agentId: "codex",
      bindingId: "workspace",
      commandId: "command-1",
      directoryId: "root",
      images: [
        { data: "aW1hZ2U=", mimeType: "image/png", name: "preview.png" },
      ],
      kind: SESSION_PROMPT_KIND,
      prompt: "inspect",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      resources: [],
      sessionId: "session-1",
    });
    actor.receiveHostMessage(host, prompt);
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
    actor.receiveDaemonMessage(
      daemon,
      encodeAgentContentEvent({
        commandId: "command-1",
        content: {
          data: "aW1hZ2U=",
          mimeType: "image/png",
          name: "",
          newText: "",
          oldText: "",
          path: "",
          terminalId: "",
          text: "",
          type: "image",
          uri: "",
        },
        contentId: "content-1",
        kind: AGENT_CONTENT_KIND,
        messageId: "message-1",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: "session-1",
      }),
    );

    expect(actor.readHistory()).toMatchObject({
      sessions: [
        {
          pendingPermissions: [{ interactionId: "permission-1" }],
          sessionId: "session-1",
          usage: [{ size: 200_000, used: 50_000 }],
        },
      ],
      turns: [
        {
          contents: [{ contentId: "content-1" }],
          images: [{ name: "preview.png" }],
        },
      ],
    });
  });
});
