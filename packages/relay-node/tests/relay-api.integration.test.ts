import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_ACTIVITY_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  type RecordedSessionEvent,
  SESSION_COMPLETED_KIND,
  SESSION_EVENT_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
  type SessionEventEnvelope,
  type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import {
  type ChannelRuntime,
  createMobiusApplication,
  type PairingDirectory,
  PairingDirectoryError,
  ProjectScope,
  ProjectScopeAccess,
} from "@moxt-ai/mobius-relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNodeRelay, type NodeRelay } from "../src/node-relay.ts";
import { NodeSessionRuntime } from "../src/node-session-runtime.ts";

const fixedTime = Date.parse("2026-09-06T00:00:00.000Z");
const token = "node-test-token-abcdefghijklmnopqrstuvwxyz";
const scope = new ProjectScope("tenant-node", "project-node");
const createdDirectories: string[] = [];
const attemptIdsBySession = new Map<string, string>();
const sourceSequences = new Map<string, number>();

class ScopedPairingDirectory implements PairingDirectory {
  readonly authorizeDaemon = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "unauthorized",
      "Not available in this scenario",
    );
  };

  readonly authorizeHost = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "unauthorized",
      "Not available in this scenario",
    );
  };

  readonly authorizeProject = async (
    projectId: string,
    candidateToken: string,
    signal: AbortSignal,
  ): Promise<ProjectScopeAccess> => {
    signal.throwIfAborted();
    if (projectId !== scope.projectId || candidateToken !== token) {
      throw new PairingDirectoryError("unauthorized", "Project access denied");
    }
    return new ProjectScopeAccess(scope.tenantId, scope.projectId);
  };

  readonly claimPairing = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "invalid_request",
      "Not available in this scenario",
    );
  };

  readonly createChannelAccessGrant = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "invalid_request",
      "Not available in this scenario",
    );
  };

  readonly createPairing = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "invalid_request",
      "Not available in this scenario",
    );
  };

  readonly listLinkedChannelDevices = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "invalid_request",
      "Not available in this scenario",
    );
  };

  readonly readChannel = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "unauthorized",
      "Not available in this scenario",
    );
  };

  readonly readPairingStatus = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "unauthorized",
      "Not available in this scenario",
    );
  };

  readonly redeemChannelAccessGrant = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "invalid_request",
      "Not available in this scenario",
    );
  };

  readonly revokeLinkedChannelDevice = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "invalid_request",
      "Not available in this scenario",
    );
  };

  readonly updateAgentCatalog = async (): Promise<never> => {
    throw new PairingDirectoryError(
      "unauthorized",
      "Not available in this scenario",
    );
  };
}

class InertChannelRuntime implements ChannelRuntime {
  readonly acceptDaemon = async (): Promise<Response> =>
    new Response(null, { status: 501 });

  readonly acceptHost = async (): Promise<Response> =>
    new Response(null, { status: 501 });

  readonly disconnectHost = async (): Promise<void> => {};
}

function prompt(sessionId: string): SessionPromptCommand {
  return {
    additionalDirectoryIds: [],
    agentId: "codex",
    bindingId: "workspace",
    commandId: "node-command",
    directoryId: "root",
    images: [
      {
        data: "aW1hZ2UtYnl0ZXM=",
        mimeType: "image/png",
        name: "diagram.png",
      },
    ],
    kind: SESSION_PROMPT_KIND,
    prompt: "inspect the Node deployment",
    resources: [
      {
        mimeType: "text/plain",
        name: "notes.txt",
        text: "retained attachment",
        type: "embedded",
        uri: "file:///notes.txt",
      },
    ],
    sessionId,
  };
}

function envelope(
  sessionId: string,
  eventId: string,
  event: RecordedSessionEvent,
): SessionEventEnvelope {
  const attemptId =
    event.kind === SESSION_STARTED_KIND
      ? event.attemptId
      : "commandId" in event
        ? attemptIdsBySession.get(sessionId)
        : undefined;
  if (event.kind === SESSION_STARTED_KIND) {
    attemptIdsBySession.set(sessionId, event.attemptId);
  }
  if ("commandId" in event && attemptId === undefined) {
    throw new Error("An execution event has no Attempt source identity");
  }
  const sourceKey =
    attemptId === undefined
      ? `runtime:${sessionId}`
      : `attempt:${sessionId}:${attemptId}`;
  const sourceSequence = (sourceSequences.get(sourceKey) ?? 0) + 1;
  sourceSequences.set(sourceKey, sourceSequence);
  return {
    eventId,
    kind: SESSION_EVENT_KIND,
    payload: JSON.stringify(event),
    sessionId,
    source:
      attemptId === undefined
        ? { kind: "runtime", sourceSeq: sourceSequence.toString() }
        : {
            attemptId,
            kind: "attempt",
            sourceSeq: sourceSequence.toString(),
          },
  };
}

function authorized(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(`https://node.relay.test${path}`, { ...init, headers });
}

async function createSession(
  relay: NodeRelay,
  sessionId: string,
): Promise<Response> {
  return await relay.fetch(
    authorized(`/mobius/api/projects/${scope.projectId}/sessions`, {
      body: JSON.stringify({
        agentId: "codex",
        bindingId: "workspace",
        directoryId: "root",
        policy: {
          contentLimitBytes: 100_000,
          hotEventLimit: 10,
          level: "full",
          retentionMilliseconds: 86_400_000,
        },
        runtimeId: "runtime-node",
        sessionId,
        title: `Node ${sessionId}`,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(fixedTime);
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Node public Relay API", () => {
  it("Given a host-provided Mobius environment, When the host resolves the application, Then it can serve Relay requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-node-application-"));
    createdDirectories.push(directory);
    const sessionRuntime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
    );
    const injector = createMobiusApplication({
      channelRuntime: new InertChannelRuntime(),
      pairingDirectory: new ScopedPairingDirectory(),
      sessionRuntime,
    });
    const application = injector.resolve("application");

    const response = await application.fetch(
      new Request("https://node.relay.test/mobius/api/health"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "mobius-relay",
      status: "ok",
    });
    sessionRuntime.close();
  });

  it("Given the shared public API scenario, When it uses SQLite and filesystem storage, Then pagination, catch-up, archives, authorization, and lifecycle errors match the cloud contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobius-node-relay-"));
    createdDirectories.push(directory);
    const relay = createNodeRelay({
      channelRuntime: new InertChannelRuntime(),
      contentRoot: join(directory, "content"),
      databasePath: join(directory, "relay.sqlite"),
      pairingDirectory: new ScopedPairingDirectory(),
    });
    const signal = new AbortController().signal;
    const sessionId = "node-session-a";
    expect((await createSession(relay, sessionId)).status).toBe(201);
    expect((await createSession(relay, "node-session-b")).status).toBe(201);

    const command = prompt(sessionId);
    await relay.sessionRuntime.acceptTurn(
      scope,
      "runtime-node",
      command,
      fixedTime + 1,
      signal,
    );
    const events: readonly SessionEventEnvelope[] = [
      envelope(sessionId, "node-started", {
        commandId: command.commandId,
        kind: SESSION_STARTED_KIND,
        attemptId: "node-attempt",
        sessionId,
      }),
      envelope(sessionId, "node-activity", {
        activityId: "node-activity",
        activityType: "tool",
        commandId: command.commandId,
        content: [],
        detail: {
          content: [],
          input: "{}",
          kind: "recorded",
          output: `begin-${"x".repeat(30_000)}-end`,
        },
        input: "{}",
        kind: AGENT_ACTIVITY_KIND,
        locations: [],
        name: "terminal",
        output: "Full output is available on demand",
        sequence: 0,
        sessionId,
        status: "completed",
        title: "Run command",
        toolKind: "execute",
      }),
      envelope(sessionId, "node-delta", {
        commandId: command.commandId,
        kind: AGENT_MESSAGE_DELTA_KIND,
        sessionId,
        text: "Node response",
      }),
      envelope(sessionId, "node-completed", {
        commandId: command.commandId,
        kind: SESSION_COMPLETED_KIND,
        sessionId,
        stopReason: "end_turn",
      }),
    ];
    for (const [index, event] of events.entries()) {
      await relay.sessionRuntime.commitEvent(
        scope,
        "runtime-node",
        event,
        fixedTime + index + 2,
        signal,
      );
    }
    await relay.sessionRuntime.runArchiveWork(scope, sessionId, signal);

    const directoryPage = await relay.fetch(
      authorized(`/mobius/api/projects/${scope.projectId}/sessions?limit=1`),
    );
    await expect(directoryPage.json()).resolves.toMatchObject({
      nextCursor: expect.any(String),
      sessions: [{ sessionId: "node-session-a" }],
    });
    const messages = await relay.fetch(
      authorized(
        `/mobius/api/projects/${scope.projectId}/sessions/${sessionId}/messages?limit=1`,
      ),
    );
    await expect(messages.json()).resolves.toMatchObject({
      messages: [
        {
          commandId: command.commandId,
          images: command.images,
          resources: command.resources,
          response: "Node response",
        },
      ],
      nextCursor: null,
    });

    const firstEvents = await relay.fetch(
      authorized(
        `/mobius/api/projects/${scope.projectId}/sessions/${sessionId}/events?limit=1`,
      ),
    );
    const firstPage: unknown = await firstEvents.json();
    expect(firstPage).toMatchObject({
      events: [{ eventId: "node-started" }],
      hasMore: true,
    });
    if (
      typeof firstPage !== "object" ||
      firstPage === null ||
      !("cursor" in firstPage) ||
      typeof firstPage.cursor !== "string"
    ) {
      throw new Error("Expected an event cursor");
    }
    const catchup = await relay.fetch(
      authorized(
        `/mobius/api/projects/${scope.projectId}/sessions/${sessionId}/events?limit=10&cursor=${encodeURIComponent(firstPage.cursor)}`,
      ),
    );
    await expect(catchup.json()).resolves.toMatchObject({
      events: [
        { eventId: "node-activity" },
        { eventId: "node-delta" },
        { eventId: "node-completed" },
      ],
      hasMore: false,
    });
    const detail = await relay.fetch(
      authorized(
        `/mobius/api/projects/${scope.projectId}/sessions/${sessionId}/attempts/node-attempt/tool-calls/node-activity`,
      ),
    );
    await expect(detail.json()).resolves.toMatchObject({
      kind: "available",
      output: `begin-${"x".repeat(30_000)}-end`,
      storage: "archive",
    });

    const unauthorized = await relay.fetch(
      new Request(
        `https://node.relay.test/mobius/api/projects/${scope.projectId}/sessions`,
        { headers: { authorization: `Bearer ${"z".repeat(32)}` } },
      ),
    );
    expect(unauthorized.status).toBe(401);
    const invalidCursor = await relay.fetch(
      authorized(
        `/mobius/api/projects/${scope.projectId}/sessions/${sessionId}/events?cursor=invalid`,
      ),
    );
    expect(invalidCursor.status).toBe(400);
    await expect(invalidCursor.json()).resolves.toMatchObject({
      error: { code: "invalid_cursor" },
    });
    const oversizedBody = await relay.fetch(
      authorized(`/mobius/api/projects/${scope.projectId}/sessions`, {
        body: JSON.stringify({ padding: "😀".repeat(5_000) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(oversizedBody.status).toBe(400);
    await expect(oversizedBody.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
        message: "The request body is too large",
      },
    });

    const deleted = await relay.fetch(
      authorized(
        `/mobius/api/projects/${scope.projectId}/sessions/${sessionId}`,
        {
          method: "DELETE",
        },
      ),
    );
    expect(deleted.status).toBe(200);
    const afterDelete = await relay.fetch(
      authorized(
        `/mobius/api/projects/${scope.projectId}/sessions/${sessionId}/messages`,
      ),
    );
    expect(afterDelete.status).toBe(410);
    relay.close();
  });
});
