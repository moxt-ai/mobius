import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  AGENT_ACTIVITY_KIND,
  AGENT_INSTALL_PROGRESS_KIND,
  AGENT_INSTALL_REQUEST_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  decodeAgentInstallProgressEvent,
  decodeAgentInstallRequestCommand,
  decodeCommittedSessionEvent,
  decodeRecordedSessionEvent,
  decodeRuntimeStatusEvent,
  decodeSessionEventAcknowledgement,
  decodeSessionPrepareCommand,
  decodeSessionPromptCommand,
  encodeAgentInstallProgressEvent,
  encodeAgentInstallRequestCommand,
  encodeSessionEventEnvelope,
  encodeSessionPrepareCommand,
  encodeSessionPromptCommand,
  MOBIUS_PROTOCOL_VERSION,
  type RecordedSessionEvent,
  SESSION_COMPLETED_KIND,
  SESSION_EVENT_FORMAT_VERSION,
  SESSION_EVENT_KIND,
  SESSION_INFO_UPDATED_KIND,
  SESSION_PREPARE_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
  type SessionEventEnvelope,
  type SessionPrepareCommand,
  type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relayOrigin = "https://relay.test";
const readyAgents = [{ id: "codex", label: "Codex" }];
const installableAgents = [
  {
    id: "claude-code",
    label: "Claude Code",
    requiresLocalApproval: true,
  },
];

interface CreatedPairingResponse {
  readonly channelId: string;
  readonly expiresAt: string;
  readonly hostToken: string;
  readonly pairingCode: string;
  readonly pairingId: string;
  readonly pollToken: string;
  readonly projectId: string;
  readonly tenantId: string;
}

interface ClaimedPairingResponse {
  readonly channelId: string;
  readonly daemonToken: string;
}

interface PairedChannel {
  readonly claimed: ClaimedPairingResponse;
  readonly created: CreatedPairingResponse;
}

interface PairingRecord {
  readonly channel_id: string;
  readonly daemon_token_hash: string;
  readonly host_token_hash: string;
  readonly project_id: string;
  readonly tenant_id: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Expected ${key}`);
  }
  return field;
}

function decodeCreatedPairing(value: unknown): CreatedPairingResponse {
  if (!isRecord(value)) {
    throw new Error("Expected a pairing response object");
  }
  return {
    channelId: requiredString(value, "channelId"),
    expiresAt: requiredString(value, "expiresAt"),
    hostToken: requiredString(value, "hostToken"),
    pairingCode: requiredString(value, "pairingCode"),
    pairingId: requiredString(value, "pairingId"),
    pollToken: requiredString(value, "pollToken"),
    projectId: requiredString(value, "projectId"),
    tenantId: requiredString(value, "tenantId"),
  };
}

function decodeClaimedPairing(value: unknown): ClaimedPairingResponse {
  if (!isRecord(value)) {
    throw new Error("Expected a claimed pairing response object");
  }
  return {
    channelId: requiredString(value, "channelId"),
    daemonToken: requiredString(value, "daemonToken"),
  };
}

class SocketMessages {
  readonly #messages: string[] = [];
  readonly #resolvers: ((message: string) => void)[] = [];

  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        throw new Error("Expected a text WebSocket message");
      }
      const resolve = this.#resolvers.shift();
      if (resolve === undefined) {
        this.#messages.push(event.data);
      } else {
        resolve(event.data);
      }
    });
  }

  readonly next = (): Promise<string> => {
    const message = this.#messages.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    return new Promise((resolve) => this.#resolvers.push(resolve));
  };
}

interface OpenSocket {
  readonly messages: SocketMessages;
  readonly socket: WebSocket;
}

async function createPairing(): Promise<CreatedPairingResponse> {
  const response = await exports.default.fetch(`${relayOrigin}/v1/pairings`, {
    method: "POST",
  });
  expect(response.status).toBe(201);
  return decodeCreatedPairing(await response.json());
}

async function claimPairing(
  created: CreatedPairingResponse,
): Promise<ClaimedPairingResponse> {
  const response = await exports.default.fetch(
    `${relayOrigin}/v1/pairings/claim`,
    {
      body: JSON.stringify({
        agents: readyAgents,
        installableAgents,
        machineName: "Developer Mac",
        pairingCode: created.pairingCode,
        workspaceName: "mobius",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  expect(response.status).toBe(200);
  return decodeClaimedPairing(await response.json());
}

async function pairChannel(): Promise<PairedChannel> {
  const created = await createPairing();
  return { claimed: await claimPairing(created), created };
}

function requireWebSocket(response: Response): WebSocket {
  const socket = response.webSocket;
  if (socket === null || socket === undefined) {
    throw new Error("Expected a WebSocket upgrade response");
  }
  return socket;
}

async function openChannelSocket(path: string): Promise<OpenSocket> {
  const response = await exports.default.fetch(`${relayOrigin}${path}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = requireWebSocket(response);
  const messages = new SocketMessages(socket);
  socket.accept();
  return { messages, socket };
}

function authorization(pairing: CreatedPairingResponse): HeadersInit {
  return { authorization: `Bearer ${pairing.hostToken}` };
}

async function createSession(
  pairing: CreatedPairingResponse,
  sessionId: string,
  options: {
    readonly contentLimitBytes?: number;
    readonly hotEventLimit?: number;
    readonly retentionMilliseconds?: number;
  } = {},
): Promise<Response> {
  return await exports.default.fetch(
    `${relayOrigin}/v1/projects/${pairing.projectId}/sessions`,
    {
      body: JSON.stringify({
        agentId: "codex",
        bindingId: "workspace",
        directoryId: "root",
        policy: {
          contentLimitBytes: options.contentLimitBytes ?? 2_000_000,
          hotEventLimit: options.hotEventLimit ?? 100,
          level: "full",
          retentionMilliseconds: options.retentionMilliseconds ?? 86_400_000,
        },
        runtimeId: pairing.channelId,
        sessionId,
        title: `Session ${sessionId}`,
      }),
      headers: {
        ...authorization(pairing),
        "content-type": "application/json",
      },
      method: "POST",
    },
  );
}

function prompt(
  sessionId: string,
  commandId: string,
  text: string,
): SessionPromptCommand {
  return {
    additionalDirectoryIds: [],
    agentId: "codex",
    bindingId: "workspace",
    commandId,
    directoryId: "root",
    images: [],
    kind: SESSION_PROMPT_KIND,
    prompt: text,
    protocolVersion: MOBIUS_PROTOCOL_VERSION,
    resources: [],
    sessionId,
  };
}

function preparation(
  sessionId: string,
  requestId: string,
): SessionPrepareCommand {
  return {
    additionalDirectoryIds: [],
    agentId: "codex",
    bindingId: "workspace",
    directoryId: "root",
    kind: SESSION_PREPARE_KIND,
    protocolVersion: MOBIUS_PROTOCOL_VERSION,
    requestId,
    sessionId,
  };
}

function envelope(
  sessionId: string,
  eventId: string,
  event: RecordedSessionEvent,
): SessionEventEnvelope {
  return {
    eventId,
    eventVersion: SESSION_EVENT_FORMAT_VERSION,
    kind: SESSION_EVENT_KIND,
    payload: JSON.stringify(event),
    protocolVersion: MOBIUS_PROTOCOL_VERSION,
    sessionId,
  };
}

async function submitPrompt(
  host: OpenSocket,
  daemon: OpenSocket,
  command: SessionPromptCommand,
): Promise<void> {
  host.socket.send(encodeSessionPromptCommand(command));
  expect(decodeSessionPromptCommand(await daemon.messages.next())).toEqual(
    command,
  );
  expect(decodeSessionPromptCommand(await host.messages.next())).toEqual(
    command,
  );
}

async function commit(
  host: OpenSocket,
  daemon: OpenSocket,
  eventEnvelope: SessionEventEnvelope,
): Promise<ReturnType<typeof decodeCommittedSessionEvent>> {
  daemon.socket.send(encodeSessionEventEnvelope(eventEnvelope));
  const [acknowledgement, committed] = await Promise.all([
    daemon.messages.next().then(decodeSessionEventAcknowledgement),
    host.messages.next().then(decodeCommittedSessionEvent),
  ]);
  expect(acknowledgement).toMatchObject({
    duplicate: false,
    eventId: eventEnvelope.eventId,
    sessionId: eventEnvelope.sessionId,
  });
  expect(committed.eventId).toBe(eventEnvelope.eventId);
  return committed;
}

async function commitBatch(
  host: OpenSocket,
  daemon: OpenSocket,
  eventEnvelopes: readonly SessionEventEnvelope[],
): Promise<void> {
  const acknowledgementsPromise = Promise.all(
    eventEnvelopes.map(async () =>
      decodeSessionEventAcknowledgement(await daemon.messages.next()),
    ),
  );
  const committedPromise = Promise.all(
    eventEnvelopes.map(async () =>
      decodeCommittedSessionEvent(await host.messages.next()),
    ),
  );
  for (const eventEnvelope of eventEnvelopes) {
    daemon.socket.send(encodeSessionEventEnvelope(eventEnvelope));
  }
  const [acknowledgements, committedEvents] = await Promise.all([
    acknowledgementsPromise,
    committedPromise,
  ]);
  const acknowledgementsByEvent = new Map(
    acknowledgements.map((acknowledgement) => [
      acknowledgement.eventId,
      acknowledgement,
    ]),
  );
  const committedByEvent = new Map(
    committedEvents.map((committed) => [committed.eventId, committed]),
  );
  expect(acknowledgementsByEvent.size).toBe(eventEnvelopes.length);
  expect(committedByEvent.size).toBe(eventEnvelopes.length);
  for (const eventEnvelope of eventEnvelopes) {
    expect(acknowledgementsByEvent.get(eventEnvelope.eventId)).toMatchObject({
      duplicate: false,
      eventId: eventEnvelope.eventId,
      sessionId: eventEnvelope.sessionId,
    });
    expect(committedByEvent.get(eventEnvelope.eventId)).toMatchObject({
      eventId: eventEnvelope.eventId,
      sessionId: eventEnvelope.sessionId,
    });
  }
}

async function completeTurn(
  host: OpenSocket,
  daemon: OpenSocket,
  command: SessionPromptCommand,
  response: string,
): Promise<void> {
  await submitPrompt(host, daemon, command);
  await commit(
    host,
    daemon,
    envelope(command.sessionId, `${command.commandId}-started`, {
      commandId: command.commandId,
      kind: SESSION_STARTED_KIND,
      processAttemptId: `${command.commandId}-attempt`,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: command.sessionId,
    }),
  );
  await commit(
    host,
    daemon,
    envelope(command.sessionId, `${command.commandId}-delta`, {
      commandId: command.commandId,
      kind: AGENT_MESSAGE_DELTA_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: command.sessionId,
      text: response,
    }),
  );
  await commit(
    host,
    daemon,
    envelope(command.sessionId, `${command.commandId}-completed`, {
      commandId: command.commandId,
      kind: SESSION_COMPLETED_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: command.sessionId,
      stopReason: "end_turn",
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe.sequential("Cloudflare session deployment", () => {
  it("Given a browser pairing, When clients use channel and project resources, Then verified credentials derive one tenant and project scope", async () => {
    const created = await createPairing();
    const pending = await exports.default.fetch(
      `${relayOrigin}/v1/pairings/${created.pairingId}?token=${created.pollToken}`,
    );
    await expect(pending.json()).resolves.toEqual({
      expiresAt: created.expiresAt,
      status: "pending",
    });

    const claimed = await claimPairing(created);
    expect(claimed.channelId).toBe(created.channelId);
    const paired = await exports.default.fetch(
      `${relayOrigin}/v1/pairings/${created.pairingId}?token=${created.pollToken}`,
    );
    await expect(paired.json()).resolves.toMatchObject({
      channelId: created.channelId,
      projectId: created.projectId,
      status: "paired",
      tenantId: created.tenantId,
    });

    const channel = await exports.default.fetch(
      `${relayOrigin}/v1/channels/${created.channelId}`,
      { headers: authorization(created) },
    );
    expect(channel.status).toBe(200);
    await expect(channel.json()).resolves.toMatchObject({
      channelId: created.channelId,
      projectId: created.projectId,
      tenantId: created.tenantId,
    });
    const unauthorizedHost = await exports.default.fetch(
      `${relayOrigin}/v1/channels/${created.channelId}/host?token=${"x".repeat(43)}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(unauthorizedHost.status).toBe(401);

    const record = await env.DIRECTORY_DATABASE.prepare(
      `SELECT channel_id, daemon_token_hash, host_token_hash, project_id, tenant_id
       FROM pairing_channels WHERE pairing_id = ?`,
    )
      .bind(created.pairingId)
      .first<PairingRecord>();
    expect(record).toMatchObject({
      channel_id: created.channelId,
      daemon_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      host_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      project_id: created.projectId,
      tenant_id: created.tenantId,
    });
    expect(record?.daemon_token_hash).not.toBe(claimed.daemonToken);
    expect(record?.host_token_hash).not.toBe(created.hostToken);
  });

  it("Given independent sessions on one runtime, When history pages and a reconnect cursor are read, Then records stay ordered while duplicate delivery never reruns a command", async () => {
    const pairing = await pairChannel();
    const { channelId } = pairing.created;
    const daemon = await openChannelSocket(
      `/v1/channels/${channelId}/daemon?token=${pairing.claimed.daemonToken}`,
    );
    const host = await openChannelSocket(
      `/v1/channels/${channelId}/host?token=${pairing.created.hostToken}`,
    );
    expect(decodeRuntimeStatusEvent(await host.messages.next())).toMatchObject({
      online: true,
      runtimeId: channelId,
    });

    try {
      expect((await createSession(pairing.created, "session-a")).status).toBe(
        201,
      );
      expect((await createSession(pairing.created, "session-b")).status).toBe(
        201,
      );
      for (const [index, text] of ["first", "second", "third"].entries()) {
        vi.setSystemTime(
          new Date(`2026-09-06T00:00:0${index.toString()}.000Z`),
        );
        await completeTurn(
          host,
          daemon,
          prompt("session-a", `command-a-${(index + 1).toString()}`, text),
          `${text} response`,
        );
      }

      const running = prompt("session-b", "command-b-1", "keep running");
      await submitPrompt(host, daemon, running);
      const startedEnvelope = envelope("session-b", "b-started", {
        commandId: running.commandId,
        kind: SESSION_STARTED_KIND,
        processAttemptId: "attempt-b",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: running.sessionId,
      });
      const firstLive = await commit(host, daemon, startedEnvelope);

      const messages = await exports.default.fetch(
        `${relayOrigin}/v1/projects/${pairing.created.projectId}/sessions/session-a/messages?limit=2`,
        { headers: authorization(pairing.created) },
      );
      expect(messages.status).toBe(200);
      const firstPage: unknown = await messages.json();
      expect(firstPage).toMatchObject({
        messages: [
          { commandId: "command-a-3", response: "third response" },
          { commandId: "command-a-2", response: "second response" },
        ],
        nextCursor: expect.any(String),
      });
      if (!isRecord(firstPage)) {
        throw new Error("Expected a message page");
      }
      const nextCursor = requiredString(firstPage, "nextCursor");
      const older = await exports.default.fetch(
        `${relayOrigin}/v1/projects/${pairing.created.projectId}/sessions/session-a/messages?limit=2&cursor=${encodeURIComponent(nextCursor)}`,
        { headers: authorization(pairing.created) },
      );
      await expect(older.json()).resolves.toMatchObject({
        messages: [{ commandId: "command-a-1", response: "first response" }],
        nextCursor: null,
      });

      daemon.socket.send(encodeSessionEventEnvelope(startedEnvelope));
      expect(
        decodeSessionEventAcknowledgement(await daemon.messages.next()),
      ).toMatchObject({ duplicate: true, eventId: "b-started" });
      const deltaEnvelope = envelope("session-b", "b-delta", {
        commandId: running.commandId,
        kind: AGENT_MESSAGE_DELTA_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: running.sessionId,
        text: "still running",
      });
      const nextLive = await commit(host, daemon, deltaEnvelope);
      expect(nextLive.sequence).toBe(firstLive.sequence + 1);

      const catchup = await exports.default.fetch(
        `${relayOrigin}/v1/projects/${pairing.created.projectId}/sessions/session-b/events?limit=10&cursor=${encodeURIComponent(firstLive.cursor)}`,
        { headers: authorization(pairing.created) },
      );
      await expect(catchup.json()).resolves.toMatchObject({
        events: [{ eventId: "b-delta", sequence: nextLive.sequence }],
        hasMore: false,
      });

      host.socket.send(encodeSessionPromptCommand(running));
      await expect(host.messages.next()).resolves.toContain(
        "duplicate_running",
      );
      const installRequest = encodeAgentInstallRequestCommand({
        agentId: "claude-code",
        kind: AGENT_INSTALL_REQUEST_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        requestId: "install-after-duplicate",
      });
      host.socket.send(installRequest);
      expect(
        decodeAgentInstallRequestCommand(await daemon.messages.next()),
      ).toEqual(decodeAgentInstallRequestCommand(installRequest));

      const sessionStub = env.SESSION_RELAY.get(
        env.SESSION_RELAY.idFromName(
          `${pairing.created.tenantId}:${pairing.created.projectId}:session-a`,
        ),
      );
      await evictDurableObject(sessionStub);
      const recovered = await exports.default.fetch(
        `${relayOrigin}/v1/projects/${pairing.created.projectId}/sessions/session-a/messages?limit=1`,
        { headers: authorization(pairing.created) },
      );
      await expect(recovered.json()).resolves.toMatchObject({
        messages: [{ commandId: "command-a-3" }],
      });
    } finally {
      host.socket.close(1000, "Worker integration complete");
      daemon.socket.close(1000, "Worker integration complete");
    }
  });

  it("Given an Agent titled a prepared session, When the browser reconnects and prepares it again, Then the same session resumes without closing the channel", async () => {
    const pairing = await pairChannel();
    const { channelId } = pairing.created;
    const daemon = await openChannelSocket(
      `/v1/channels/${channelId}/daemon?token=${pairing.claimed.daemonToken}`,
    );
    const firstHost = await openChannelSocket(
      `/v1/channels/${channelId}/host?token=${pairing.created.hostToken}`,
    );
    expect(
      decodeRuntimeStatusEvent(await firstHost.messages.next()).online,
    ).toBe(true);

    const firstPreparation = preparation("reconnected-session", "prepare-1");
    firstHost.socket.send(encodeSessionPrepareCommand(firstPreparation));
    expect(decodeSessionPrepareCommand(await daemon.messages.next())).toEqual(
      firstPreparation,
    );
    expect(
      decodeSessionPrepareCommand(await firstHost.messages.next()),
    ).toEqual(firstPreparation);

    await commit(
      firstHost,
      daemon,
      envelope("reconnected-session", "generated-title", {
        kind: SESSION_INFO_UPDATED_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: "reconnected-session",
        title: "Generated session title",
        updatedAt: "2026-09-06T00:00:00.000Z",
      }),
    );
    firstHost.socket.close(1000, "Browser reload");

    const secondHost = await openChannelSocket(
      `/v1/channels/${channelId}/host?token=${pairing.created.hostToken}`,
    );
    expect(
      decodeRuntimeStatusEvent(await secondHost.messages.next()).online,
    ).toBe(true);

    try {
      const resumedPreparation = preparation(
        "reconnected-session",
        "prepare-2",
      );
      secondHost.socket.send(encodeSessionPrepareCommand(resumedPreparation));
      expect(decodeSessionPrepareCommand(await daemon.messages.next())).toEqual(
        resumedPreparation,
      );
      expect(
        decodeSessionPrepareCommand(await secondHost.messages.next()),
      ).toEqual(resumedPreparation);
    } finally {
      secondHost.socket.close(1000, "Worker integration complete");
      daemon.socket.close(1000, "Worker integration complete");
    }
  });

  it("Given a turn is running, When its daemon disconnects and restarts, Then the unknown outcome is retained and the session accepts a new turn", async () => {
    const pairing = await pairChannel();
    const sessionId = "daemon-restart-session";
    expect((await createSession(pairing.created, sessionId)).status).toBe(201);
    const daemon = await openChannelSocket(
      `/v1/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
    );
    const host = await openChannelSocket(
      `/v1/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
    );
    expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(
      true,
    );

    const interrupted = prompt(
      sessionId,
      "interrupted-command",
      "run until disconnected",
    );
    await submitPrompt(host, daemon, interrupted);
    await commit(
      host,
      daemon,
      envelope(sessionId, "interrupted-started", {
        commandId: interrupted.commandId,
        kind: SESSION_STARTED_KIND,
        processAttemptId: "interrupted-attempt",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId,
      }),
    );
    daemon.socket.close(1000, "Daemon restart");
    expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(
      false,
    );

    const interruptedHistory = await exports.default.fetch(
      `${relayOrigin}/v1/projects/${pairing.created.projectId}/sessions/${sessionId}/messages`,
      { headers: authorization(pairing.created) },
    );
    await expect(interruptedHistory.json()).resolves.toMatchObject({
      messages: [
        {
          attempt: {
            kind: "outcome_unknown",
            processAttemptId: "interrupted-attempt",
          },
          commandId: interrupted.commandId,
        },
      ],
    });

    const replacement = await openChannelSocket(
      `/v1/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
    );
    expect(decodeRuntimeStatusEvent(await host.messages.next()).online).toBe(
      true,
    );
    try {
      const recovered = prompt(
        sessionId,
        "recovered-command",
        "continue after restart",
      );
      await completeTurn(host, replacement, recovered, "recovered response");
      const recoveredHistory = await exports.default.fetch(
        `${relayOrigin}/v1/projects/${pairing.created.projectId}/sessions/${sessionId}/messages`,
        { headers: authorization(pairing.created) },
      );
      await expect(recoveredHistory.json()).resolves.toMatchObject({
        messages: [
          {
            attempt: { kind: "completed" },
            commandId: recovered.commandId,
            response: "recovered response",
          },
          {
            attempt: { kind: "outcome_unknown" },
            commandId: interrupted.commandId,
          },
        ],
      });
    } finally {
      host.socket.close(1000, "Worker integration complete");
      replacement.socket.close(1000, "Worker integration complete");
    }
  });

  it("Given a large tool record and a pre-uploaded segment, When archive recovery runs, Then full details remain readable and immutable segments are bounded", async () => {
    const pairing = await pairChannel();
    const sessionId = "large-session";
    expect(
      (
        await createSession(pairing.created, sessionId, {
          contentLimitBytes: 2_000_000,
        })
      ).status,
    ).toBe(201);
    const daemon = await openChannelSocket(
      `/v1/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
    );
    const host = await openChannelSocket(
      `/v1/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
    );
    await host.messages.next();

    try {
      const command = prompt(sessionId, "large-command", "run verbose tool");
      await submitPrompt(host, daemon, command);
      await commit(
        host,
        daemon,
        envelope(sessionId, "large-started", {
          commandId: command.commandId,
          kind: SESSION_STARTED_KIND,
          processAttemptId: "large-attempt",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId,
        }),
      );
      const fullOutput = `begin-${"large output line\n".repeat(35_000)}-end`;
      const activityEnvelope = envelope(sessionId, "large-activity", {
        activityId: "activity-large",
        activityType: "tool",
        commandId: command.commandId,
        content: [],
        detail: {
          content: [],
          input: "{}",
          kind: "recorded",
          output: fullOutput,
        },
        input: "{}",
        kind: AGENT_ACTIVITY_KIND,
        locations: [],
        name: "terminal",
        output: fullOutput.slice(0, 24_000),
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sequence: 0,
        sessionId,
        status: "completed",
        title: "Run terminal command",
        toolKind: "execute",
      });
      const committed = await commit(host, daemon, activityEnvelope);
      const recorded = decodeRecordedSessionEvent(committed.payload);
      expect(recorded).toMatchObject({
        detail: { kind: "available" },
        output: fullOutput.slice(0, 24_000),
      });

      const artifactId = "activity-large-activity";
      const detailPayload = JSON.stringify({
        content: [],
        input: "{}",
        output: fullOutput,
      });
      const stub = env.SESSION_RELAY.get(
        env.SESSION_RELAY.idFromName(
          `${pairing.created.tenantId}:${pairing.created.projectId}:${sessionId}`,
        ),
      );
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.deleteAlarm();
        state.storage.transactionSync(() => {
          state.storage.sql.exec(
            `UPDATE session_archives
             SET sha256 = '', segments_json = NULL
             WHERE session_id = ? AND artifact_id = ?`,
            sessionId,
            artifactId,
          );
          state.storage.sql.exec(
            `UPDATE session_activities SET hot_detail = ?
             WHERE session_id = ? AND activity_id = ?`,
            detailPayload,
            sessionId,
            "activity-large",
          );
          state.storage.sql.exec(
            `INSERT OR REPLACE INTO session_archive_jobs (
               scope_key, session_id, artifact_id, archive_kind, owner_id,
               media_type, hot_payload, attempts, last_error
             ) VALUES (?, ?, ?, 'activity', ?, 'application/json', ?, 0, '')`,
            `${pairing.created.tenantId}:${pairing.created.projectId}`,
            sessionId,
            artifactId,
            "activity-large",
            detailPayload,
          );
        });
      });
      const detailPath = `${relayOrigin}/v1/projects/${pairing.created.projectId}/sessions/${sessionId}/activities/activity-large`;
      const availableBeforeRecovery = await exports.default.fetch(detailPath, {
        headers: authorization(pairing.created),
      });
      await expect(availableBeforeRecovery.json()).resolves.toMatchObject({
        kind: "available",
        output: fullOutput,
      });
      await evictDurableObject(stub);
      await runInDurableObject(stub, async (instance) => {
        if (instance.alarm === undefined) {
          throw new Error("Expected the Session Durable Object alarm handler");
        }
        await instance.alarm();
      });
      const archived = await exports.default.fetch(detailPath, {
        headers: authorization(pairing.created),
      });
      await expect(archived.json()).resolves.toMatchObject({
        kind: "available",
        output: fullOutput,
        storage: "archive",
      });
      const objects = await env.SESSION_ARCHIVES.list({
        include: ["customMetadata"],
        prefix: `${pairing.created.tenantId}/${pairing.created.projectId}/${sessionId}/${artifactId}.`,
      });
      expect(objects.objects.length).toBeGreaterThan(1);
      expect(objects.objects.every((object) => object.size <= 192 * 1024)).toBe(
        true,
      );
    } finally {
      host.socket.close(1000, "Worker integration complete");
      daemon.socket.close(1000, "Worker integration complete");
    }
  });

  it("Given sessions in different tenant scopes and bounded retention, When callers export, import, delete, and expire data, Then isolation and availability outcomes are explicit", async () => {
    const source = await pairChannel();
    const destination = await pairChannel();
    const sessionId = "lifecycle-session";
    expect((await createSession(source.created, sessionId)).status).toBe(201);

    const unauthorized = await exports.default.fetch(
      `${relayOrigin}/v1/projects/${source.created.projectId}/sessions`,
      { headers: authorization(destination.created) },
    );
    expect(unauthorized.status).toBe(401);
    const invisible = await exports.default.fetch(
      `${relayOrigin}/v1/projects/${destination.created.projectId}/sessions/${sessionId}`,
      { headers: authorization(destination.created) },
    );
    expect(invisible.status).toBe(404);

    const exportedResponse = await exports.default.fetch(
      `${relayOrigin}/v1/projects/${source.created.projectId}/sessions/${sessionId}/export`,
      { headers: authorization(source.created) },
    );
    expect(exportedResponse.status).toBe(200);
    const exported: unknown = await exportedResponse.json();
    const imported = await exports.default.fetch(
      `${relayOrigin}/v1/projects/${destination.created.projectId}/session-imports`,
      {
        body: JSON.stringify({ export: exported }),
        headers: {
          ...authorization(destination.created),
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    expect(imported.status).toBe(201);
    await expect(imported.json()).resolves.toMatchObject({
      projectId: destination.created.projectId,
      sessionId,
      tenantId: destination.created.tenantId,
    });

    const deleted = await exports.default.fetch(
      `${relayOrigin}/v1/projects/${destination.created.projectId}/sessions/${sessionId}`,
      {
        headers: authorization(destination.created),
        method: "DELETE",
      },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ kind: "deleted" });
    const afterDelete = await exports.default.fetch(
      `${relayOrigin}/v1/projects/${destination.created.projectId}/sessions/${sessionId}/messages`,
      { headers: authorization(destination.created) },
    );
    expect(afterDelete.status).toBe(410);

    const expiringId = "retention-session";
    expect(
      (
        await createSession(source.created, expiringId, {
          retentionMilliseconds: 60_000,
        })
      ).status,
    ).toBe(201);
    vi.setSystemTime(new Date("2026-09-06T00:01:00.000Z"));
    const expired = await exports.default.fetch(
      `${relayOrigin}/v1/projects/${source.created.projectId}/sessions/${expiringId}`,
      { headers: authorization(source.created) },
    );
    expect(expired.status).toBe(410);
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: "session_deleted" },
    });
  });

  it("Given an archived event window, When a client resumes behind the retained sequence, Then the public API returns cursor_expired instead of empty history", async () => {
    const pairing = await pairChannel();
    const sessionId = "cursor-session";
    expect(
      (
        await createSession(pairing.created, sessionId, {
          hotEventLimit: 10,
        })
      ).status,
    ).toBe(201);
    const daemon = await openChannelSocket(
      `/v1/channels/${pairing.created.channelId}/daemon?token=${pairing.claimed.daemonToken}`,
    );
    const host = await openChannelSocket(
      `/v1/channels/${pairing.created.channelId}/host?token=${pairing.created.hostToken}`,
    );
    await host.messages.next();
    try {
      const command = prompt(sessionId, "cursor-command", "stream output");
      await submitPrompt(host, daemon, command);
      const first = await commit(
        host,
        daemon,
        envelope(sessionId, "cursor-started", {
          commandId: command.commandId,
          kind: SESSION_STARTED_KIND,
          processAttemptId: "cursor-attempt",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId,
        }),
      );
      const events = [
        ...Array.from({ length: 40 }, (_, index) =>
          envelope(sessionId, `cursor-delta-${index.toString()}`, {
            commandId: command.commandId,
            kind: AGENT_MESSAGE_DELTA_KIND,
            protocolVersion: MOBIUS_PROTOCOL_VERSION,
            sessionId,
            text: index.toString(),
          }),
        ),
        envelope(sessionId, "cursor-completed", {
          commandId: command.commandId,
          kind: SESSION_COMPLETED_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId,
          stopReason: "end_turn",
        }),
      ];
      for (let offset = 0; offset < events.length; offset += 10) {
        await commitBatch(host, daemon, events.slice(offset, offset + 10));
      }
      const sessionStub = env.SESSION_RELAY.get(
        env.SESSION_RELAY.idFromName(
          `${pairing.created.tenantId}:${pairing.created.projectId}:${sessionId}`,
        ),
      );
      await runInDurableObject(sessionStub, async (instance, state) => {
        if (instance.alarm === undefined) {
          throw new Error("Expected the Session Durable Object alarm handler");
        }
        await state.storage.deleteAlarm();
        await instance.alarm();
      });
      const expired = await exports.default.fetch(
        `${relayOrigin}/v1/projects/${pairing.created.projectId}/sessions/${sessionId}/events?cursor=${encodeURIComponent(first.cursor)}`,
        { headers: authorization(pairing.created) },
      );
      expect(expired.status).toBe(410);
      await expect(expired.json()).resolves.toMatchObject({
        error: { code: "cursor_expired" },
      });

      const progress = encodeAgentInstallProgressEvent({
        agentId: "claude-code",
        kind: AGENT_INSTALL_PROGRESS_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        requestId: "bounded-control",
        stage: "checking_acp",
      });
      daemon.socket.send(progress);
      expect(
        decodeAgentInstallProgressEvent(await host.messages.next()),
      ).toEqual(decodeAgentInstallProgressEvent(progress));
    } finally {
      host.socket.close(1000, "Worker integration complete");
      daemon.socket.close(1000, "Worker integration complete");
    }
  });

  it("Given a configured project session quota, When public callers exhaust and release it, Then admission returns an explicit retryable outcome", async () => {
    const pairing = await pairChannel();
    const invalidImport = await exports.default.fetch(
      `${relayOrigin}/v1/projects/${pairing.created.projectId}/session-imports`,
      {
        body: JSON.stringify({
          export: { session: { sessionId: "invalid-import" } },
        }),
        headers: {
          ...authorization(pairing.created),
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    expect(invalidImport.status).toBe(400);
    await expect(invalidImport.json()).resolves.toMatchObject({
      error: { code: "invalid_export" },
    });
    expect((await createSession(pairing.created, "quota-first")).status).toBe(
      201,
    );
    expect((await createSession(pairing.created, "quota-second")).status).toBe(
      201,
    );

    const exhausted = await createSession(pairing.created, "quota-third");
    expect(exhausted.status).toBe(429);
    await expect(exhausted.json()).resolves.toMatchObject({
      error: { code: "session_quota_exceeded" },
    });
    expect((await createSession(pairing.created, "quota-first")).status).toBe(
      201,
    );

    const deleted = await exports.default.fetch(
      `${relayOrigin}/v1/projects/${pairing.created.projectId}/sessions/quota-first`,
      { headers: authorization(pairing.created), method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect((await createSession(pairing.created, "quota-third")).status).toBe(
      201,
    );
  });
});
