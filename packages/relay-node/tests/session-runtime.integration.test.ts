import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_ACTIVITY_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  decodeSessionEventEnvelope,
  type RecordedSessionEvent,
  SESSION_COMPLETED_KIND,
  SESSION_CONFIG_UPDATED_KIND,
  SESSION_ELICITATION_REQUESTED_KIND,
  SESSION_ELICITATION_RESOLVED_KIND,
  SESSION_EVENT_KIND,
  SESSION_PERMISSION_REQUESTED_KIND,
  SESSION_PERMISSION_RESOLVED_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
  type SessionEventEnvelope,
  type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import {
  type ContentTarget,
  CreateSessionBindingRequest,
  CreateSessionRequest,
  type ImmutableContent,
  type ImmutableContentStore,
  ProjectScope,
  SessionQuotaPolicy,
  SessionRecordingPolicy,
  SessionRuntimeError,
  SqliteSessionRuntime,
} from "@moxt-ai/mobius-relay-core";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemContentStore } from "../src/filesystem-content-store.ts";
import { NodeSessionRuntime } from "../src/node-session-runtime.ts";
import { NodeSqlDatabase } from "../src/node-sql-database.ts";

const fixedTime = Date.parse("2026-09-06T00:00:00.000Z");
const createdDirectories: string[] = [];
const attemptIdsBySession = new Map<string, string>();
const sourceSequences = new Map<string, number>();

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
    resources: [],
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

class FailAfterFirstWriteStore implements ImmutableContentStore {
  readonly #delegate: ImmutableContentStore;
  #failed = false;

  constructor(delegate: ImmutableContentStore) {
    this.#delegate = delegate;
  }

  readonly delete = (
    target: ContentTarget,
    signal: AbortSignal,
  ): Promise<void> => this.#delegate.delete(target, signal);

  readonly inspect = (target: ContentTarget, signal: AbortSignal) =>
    this.#delegate.inspect(target, signal);

  readonly read = (target: ContentTarget, signal: AbortSignal) =>
    this.#delegate.read(target, signal);

  readonly write = async (
    target: ContentTarget,
    content: ImmutableContent,
    signal: AbortSignal,
  ): Promise<void> => {
    await this.#delegate.write(target, content, signal);
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("Simulated interruption after immutable upload");
    }
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mobius-session-runtime-"));
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Node SQLite and filesystem session deployment", () => {
  it("Given two Attempts reuse the same tool call identifier, When each detail is read by its composite identity, Then the bounded views never cross Attempt boundaries", async () => {
    const directory = await temporaryDirectory();
    const runtime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
    );
    const scope = new ProjectScope("tenant-a", "project-a");
    const signal = new AbortController().signal;
    const sessionId = "tool-identity-session";
    await runtime.createSession(
      scope,
      new CreateSessionRequest(
        sessionId,
        "runtime-a",
        "codex",
        "workspace",
        "root",
        new SessionRecordingPolicy("full", 86_400_000, 20, 100_000),
      ),
      fixedTime,
      signal,
    );
    for (const [index, output] of [
      "first attempt",
      "second attempt",
    ].entries()) {
      const commandId = `tool-submit-${index.toString()}`;
      const attemptId = `tool-attempt-${index.toString()}`;
      await runtime.acceptTurn(
        scope,
        "runtime-a",
        prompt(sessionId, commandId, `run ${output}`),
        fixedTime + index * 10 + 1,
        signal,
      );
      await runtime.commitEvent(
        scope,
        "runtime-a",
        envelope(sessionId, `tool-started-${index.toString()}`, {
          commandId,
          kind: SESSION_STARTED_KIND,
          attemptId: attemptId,
          sessionId,
        }),
        fixedTime + index * 10 + 2,
        signal,
      );
      await runtime.commitEvent(
        scope,
        "runtime-a",
        envelope(sessionId, `tool-activity-${index.toString()}`, {
          activityId: "shared-tool-call",
          activityType: "tool",
          commandId,
          content: [],
          detail: { content: [], input: "{}", kind: "recorded", output },
          input: "{}",
          kind: AGENT_ACTIVITY_KIND,
          locations: [],
          name: "terminal",
          output,
          sequence: 0,
          sessionId,
          status: "completed",
          title: "Run command",
          toolKind: "execute",
        }),
        fixedTime + index * 10 + 3,
        signal,
      );
      await runtime.commitEvent(
        scope,
        "runtime-a",
        envelope(sessionId, `tool-completed-${index.toString()}`, {
          commandId,
          kind: SESSION_COMPLETED_KIND,
          sessionId,
          stopReason: "end_turn",
        }),
        fixedTime + index * 10 + 4,
        signal,
      );
    }

    await expect(
      runtime.readToolCallDetail(
        scope,
        sessionId,
        "tool-attempt-0",
        "shared-tool-call",
        signal,
      ),
    ).resolves.toMatchObject({ output: "first attempt" });
    await expect(
      runtime.readToolCallDetail(
        scope,
        sessionId,
        "tool-attempt-1",
        "shared-tool-call",
        signal,
      ),
    ).resolves.toMatchObject({ output: "second attempt" });
    runtime.close();
  });

  it("Given a running Attempt, When the Runtime requests permission, Then a pending Interaction is durably linked to the pinned Turn and the Attempt waits for input", async () => {
    const directory = await temporaryDirectory();
    const runtime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
    );
    const scope = new ProjectScope("tenant-a", "project-a");
    const signal = new AbortController().signal;
    const sessionId = "interaction-session";
    await runtime.createSession(
      scope,
      new CreateSessionRequest(
        sessionId,
        "runtime-a",
        "codex",
        "binding-a",
        "workspace-a",
        new SessionRecordingPolicy("full", 86_400_000, 10, 100_000),
      ),
      fixedTime,
      signal,
    );
    const accepted = await runtime.acceptTurn(
      scope,
      "runtime-a",
      {
        ...prompt(
          sessionId,
          "interaction-submit",
          "perform the protected action",
        ),
        bindingId: "binding-a",
        directoryId: "workspace-a",
      },
      fixedTime + 1,
      signal,
    );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "interaction-started", {
        commandId: "interaction-submit",
        kind: SESSION_STARTED_KIND,
        attemptId: "attempt-interaction",
        sessionId,
      }),
      fixedTime + 2,
      signal,
    );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "permission-requested", {
        commandId: "interaction-submit",
        interactionId: "permission-interaction",
        kind: SESSION_PERMISSION_REQUESTED_KIND,
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
        sessionId,
        title: "Allow protected action?",
        toolCallId: "tool-protected",
        toolKind: "execute",
      }),
      fixedTime + 3,
      signal,
    );

    expect(accepted.turn.state).toEqual({ kind: "queued" });
    await expect(
      runtime.readInteraction(
        scope,
        sessionId,
        "permission-interaction",
        signal,
      ),
    ).resolves.toMatchObject({
      attemptId: "attempt-interaction",
      interactionId: "permission-interaction",
      request: {
        kind: "permission",
        options: [
          { kind: "allow_once", name: "Allow once", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
        title: "Allow protected action?",
        toolCallId: "tool-protected",
        toolKind: "execute",
      },
      state: { kind: "pending" },
      turnId: accepted.turn.turnId,
    });
    await expect(
      runtime.readPendingInteractions(scope, sessionId, signal),
    ).resolves.toEqual([
      expect.objectContaining({
        interactionId: "permission-interaction",
        state: { kind: "pending" },
      }),
    ]);
    await expect(
      runtime.readAttempt(scope, sessionId, "attempt-interaction", signal),
    ).resolves.toMatchObject({
      state: {
        interactionIds: ["permission-interaction"],
        kind: "waiting_input",
      },
    });
    const response = {
      content: '{"optionId":"allow","outcome":"selected"}',
      kind: "permission",
    } as const;
    const firstResponse = await runtime.acceptInteractionResponse(
      scope,
      sessionId,
      "permission-interaction",
      "host-a",
      response,
      "encoded-permission-response",
      fixedTime + 4,
      signal,
    );
    expect(firstResponse).toMatchObject({
      duplicate: false,
      interaction: { state: { kind: "responded" } },
      pendingWork: {
        kind: "interaction_response",
        state: { kind: "pending" },
      },
    });
    await expect(
      runtime.acceptInteractionResponse(
        scope,
        sessionId,
        "permission-interaction",
        "host-a",
        response,
        "encoded-permission-response",
        fixedTime + 5,
        signal,
      ),
    ).resolves.toMatchObject({ duplicate: true });
    await expect(
      runtime.acceptInteractionResponse(
        scope,
        sessionId,
        "permission-interaction",
        "host-a",
        { content: '{"outcome":"cancelled"}', kind: "permission" },
        "changed-response",
        fixedTime + 6,
        signal,
      ),
    ).rejects.toMatchObject({ code: "interaction_conflict" });
    await expect(
      runtime.readInteraction(
        scope,
        sessionId,
        "permission-interaction",
        signal,
      ),
    ).resolves.toMatchObject({ state: { kind: "responded" } });

    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "permission-resolved", {
        interactionId: "permission-interaction",
        kind: SESSION_PERMISSION_RESOLVED_KIND,
        optionId: "allow",
        outcome: "selected",
        sessionId,
      }),
      fixedTime + 7,
      signal,
    );
    await expect(
      runtime.readInteraction(
        scope,
        sessionId,
        "permission-interaction",
        signal,
      ),
    ).resolves.toMatchObject({ state: { kind: "resolved" } });
    await expect(
      runtime.readPendingInteractions(scope, sessionId, signal),
    ).resolves.toEqual([]);
    await expect(
      runtime.readAttempt(scope, sessionId, "attempt-interaction", signal),
    ).resolves.toMatchObject({ state: { kind: "running" } });
    runtime.close();
  });

  it("Given a URL elicitation response was accepted, When the Agent later reports out-of-band completion, Then the same Interaction resolves once without disconnecting execution", async () => {
    const directory = await temporaryDirectory();
    const runtime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
    );
    const scope = new ProjectScope("tenant-a", "project-a");
    const signal = new AbortController().signal;
    const sessionId = "url-elicitation-session";
    await runtime.createSession(
      scope,
      new CreateSessionRequest(
        sessionId,
        "runtime-a",
        "codex",
        "binding-a",
        "workspace-a",
        new SessionRecordingPolicy("full", 86_400_000, 10, 100_000),
      ),
      fixedTime,
      signal,
    );
    await runtime.acceptTurn(
      scope,
      "runtime-a",
      {
        ...prompt(sessionId, "url-submit", "connect account"),
        bindingId: "binding-a",
        directoryId: "workspace-a",
      },
      fixedTime + 1,
      signal,
    );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "url-started", {
        attemptId: "attempt-url",
        commandId: "url-submit",
        kind: SESSION_STARTED_KIND,
        sessionId,
      }),
      fixedTime + 2,
      signal,
    );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "url-requested", {
        accepted: false,
        commandId: "url-submit",
        elicitationId: "agent-url",
        fields: [],
        interactionId: "url-interaction",
        kind: SESSION_ELICITATION_REQUESTED_KIND,
        message: "Connect account",
        mode: "url",
        sessionId,
        url: "https://example.test/connect",
      }),
      fixedTime + 3,
      signal,
    );
    await runtime.acceptInteractionResponse(
      scope,
      sessionId,
      "url-interaction",
      "host-a",
      { content: '{"action":"accept","content":""}', kind: "elicitation" },
      "encoded-url-response",
      fixedTime + 4,
      signal,
    );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "url-accepted", {
        action: "accept",
        interactionId: "url-interaction",
        kind: SESSION_ELICITATION_RESOLVED_KIND,
        sessionId,
      }),
      fixedTime + 5,
      signal,
    );
    await expect(
      runtime.readInteraction(scope, sessionId, "url-interaction", signal),
    ).resolves.toMatchObject({ state: { kind: "responded" } });
    await expect(
      runtime.readAttempt(scope, sessionId, "attempt-url", signal),
    ).resolves.toMatchObject({ state: { kind: "waiting_input" } });

    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "url-completed", {
        action: "complete",
        interactionId: "url-interaction",
        kind: SESSION_ELICITATION_RESOLVED_KIND,
        sessionId,
      }),
      fixedTime + 6,
      signal,
    );
    await expect(
      runtime.readInteraction(scope, sessionId, "url-interaction", signal),
    ).resolves.toMatchObject({ state: { kind: "resolved" } });
    await expect(
      runtime.readAttempt(scope, sessionId, "attempt-url", signal),
    ).resolves.toMatchObject({ state: { kind: "running" } });
    runtime.close();
  });

  it("Given an active Attempt with a missing daemon event, When a later source sequence arrives first, Then the gap is rejected without applying the terminal transition", async () => {
    const directory = await temporaryDirectory();
    const runtime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
    );
    const scope = new ProjectScope("tenant-a", "project-a");
    const signal = new AbortController().signal;
    const sessionId = "source-gap-session";
    const attemptId = "source-gap-attempt";
    await runtime.createSession(
      scope,
      new CreateSessionRequest(
        sessionId,
        "runtime-a",
        "codex",
        "workspace",
        "root",
        new SessionRecordingPolicy("full", 86_400_000, 10, 100_000),
      ),
      fixedTime,
      signal,
    );
    const command = prompt(sessionId, "source-gap-submit", "run once");
    await runtime.acceptTurn(
      scope,
      "runtime-a",
      command,
      fixedTime + 1,
      signal,
    );
    const sourced = (
      eventId: string,
      sourceSeq: string,
      event: RecordedSessionEvent,
    ): SessionEventEnvelope =>
      decodeSessionEventEnvelope(
        JSON.stringify({
          eventId,
          kind: SESSION_EVENT_KIND,
          payload: JSON.stringify(event),
          sessionId,
          source: { attemptId, kind: "attempt", sourceSeq },
        }),
      );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      sourced("source-gap-started", "1", {
        commandId: command.commandId,
        kind: SESSION_STARTED_KIND,
        attemptId,
        sessionId,
      }),
      fixedTime + 2,
      signal,
    );
    const completed = sourced("source-gap-completed", "3", {
      commandId: command.commandId,
      kind: SESSION_COMPLETED_KIND,
      sessionId,
      stopReason: "end_turn",
    });
    await expect(
      runtime.commitEvent(scope, "runtime-a", completed, fixedTime + 3, signal),
    ).rejects.toMatchObject({ code: "event_source_conflict" });
    await expect(
      runtime.readAttempt(scope, sessionId, attemptId, signal),
    ).resolves.toMatchObject({ state: { kind: "running" } });

    await runtime.commitEvent(
      scope,
      "runtime-a",
      sourced("source-gap-delta", "2", {
        commandId: command.commandId,
        kind: AGENT_MESSAGE_DELTA_KIND,
        sessionId,
        text: "complete output",
      }),
      fixedTime + 4,
      signal,
    );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      completed,
      fixedTime + 5,
      signal,
    );
    await expect(
      runtime.readAttempt(scope, sessionId, attemptId, signal),
    ).resolves.toMatchObject({ state: { kind: "succeeded" } });
    runtime.close();
  });

  it("Given acknowledged Attempt events and a cursor before hot-log compaction, When the events are archived and retransmitted, Then decimal ordering and source deduplication survive without invalidating the cursor", async () => {
    const directory = await temporaryDirectory();
    const runtime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
    );
    const scope = new ProjectScope("tenant-a", "project-a");
    const signal = new AbortController().signal;
    const sessionId = "source-dedup-session";
    await runtime.createSession(
      scope,
      new CreateSessionRequest(
        sessionId,
        "runtime-a",
        "codex",
        "workspace",
        "root",
        new SessionRecordingPolicy("full", 86_400_000, 10, 100_000),
      ),
      fixedTime,
      signal,
    );
    const command = prompt(sessionId, "source-dedup-submit", "run once");
    await runtime.acceptTurn(
      scope,
      "runtime-a",
      command,
      fixedTime + 1,
      signal,
    );
    const sourced = (
      eventId: string,
      sourceSeq: string,
      event: RecordedSessionEvent,
    ): SessionEventEnvelope =>
      decodeSessionEventEnvelope(
        JSON.stringify({
          eventId,
          kind: SESSION_EVENT_KIND,
          payload: JSON.stringify(event),
          sessionId,
          source: {
            attemptId: "attempt-source-dedup",
            kind: "attempt",
            sourceSeq,
          },
        }),
      );
    const started = sourced("source-event-1", "1", {
      commandId: command.commandId,
      kind: SESSION_STARTED_KIND,
      attemptId: "attempt-source-dedup",
      sessionId,
    });
    const first = await runtime.commitEvent(
      scope,
      "runtime-a",
      started,
      fixedTime + 2,
      signal,
    );
    expect(first.committed.sequence).toBe("1");

    for (let index = 2; index <= 45; index += 1) {
      await runtime.commitEvent(
        scope,
        "runtime-a",
        sourced(`source-event-${index.toString()}`, index.toString(), {
          commandId: command.commandId,
          kind: AGENT_MESSAGE_DELTA_KIND,
          sessionId,
          text: `${index.toString()} `,
        }),
        fixedTime + index + 1,
        signal,
      );
      if (index % 10 === 0) {
        await runtime.runArchiveWork(scope, sessionId, signal);
      }
    }
    await runtime.runArchiveWork(scope, sessionId, signal);
    await runtime.runArchiveWork(scope, sessionId, signal);

    await expect(
      runtime.readEvents(scope, sessionId, first.committed.cursor, 2, signal),
    ).resolves.toMatchObject({
      events: [{ sequence: "2" }, { sequence: "3" }],
    });
    await expect(
      runtime.commitEvent(scope, "runtime-a", started, fixedTime + 100, signal),
    ).resolves.toMatchObject({
      committed: { eventId: "source-event-1", sequence: "1" },
      duplicate: true,
    });
    await expect(
      runtime.commitEvent(
        scope,
        "runtime-a",
        sourced("conflicting-event", "1", {
          commandId: command.commandId,
          kind: AGENT_MESSAGE_DELTA_KIND,
          sessionId,
          text: "conflicting payload",
        }),
        fixedTime + 101,
        signal,
      ),
    ).rejects.toMatchObject({ code: "event_source_conflict" });
    runtime.close();
  });

  it("Given an accepted Turn with a pinned binding, When the same request is retried, the default binding changes, and the Runtime disconnects, Then the Turn and Attempt identities remain stable until explicit reconciliation", async () => {
    const directory = await temporaryDirectory();
    const runtime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
    );
    const scope = new ProjectScope("tenant-a", "project-a");
    const signal = new AbortController().signal;
    const sessionId = "stable-session";
    await runtime.createSession(
      scope,
      new CreateSessionRequest(
        sessionId,
        "runtime-a",
        "codex",
        "binding-a",
        "workspace-a",
        new SessionRecordingPolicy("full", 86_400_000, 10, 100_000),
      ),
      fixedTime,
      signal,
    );

    const request = {
      ...prompt(sessionId, "submit-a", "inspect the repository"),
      bindingId: "binding-a",
      directoryId: "workspace-a",
    };
    const accepted = await runtime.acceptTurn(
      scope,
      "runtime-a",
      request,
      fixedTime + 1,
      signal,
    );
    expect(accepted).toMatchObject({
      kind: "accepted",
      turn: {
        bindingId: "binding-a",
        idempotencyKey: "submit-a",
        state: { kind: "queued" },
      },
    });
    const duplicate = await runtime.acceptTurn(
      scope,
      "runtime-a",
      request,
      fixedTime + 2,
      signal,
    );
    expect(duplicate).toMatchObject({
      kind: "duplicate",
      turn: { turnId: accepted.turn.turnId },
    });
    const dispatches = await runtime.listPendingDaemonDeliveries(
      scope,
      "runtime-a",
      10,
      signal,
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      interactionId: null,
      pendingWork: {
        kind: "dispatch",
        state: { kind: "pending" },
      },
    });
    expect(JSON.parse(dispatches[0]?.payload ?? "null")).toMatchObject({
      commandId: "submit-a",
      kind: "session.prompt",
    });
    await runtime.markPendingWorkCompleted(
      scope,
      sessionId,
      dispatches[0]?.pendingWork.workId ?? "missing",
      fixedTime + 2,
      signal,
    );
    await expect(
      runtime.listPendingDaemonDeliveries(scope, "runtime-a", 10, signal),
    ).resolves.toEqual([]);
    await expect(
      runtime.acceptTurn(
        scope,
        "runtime-a",
        {
          ...prompt(sessionId, "submit-a", "different input"),
          bindingId: "binding-a",
          directoryId: "workspace-a",
        },
        fixedTime + 3,
        signal,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "started-stable", {
        commandId: request.commandId,
        kind: SESSION_STARTED_KIND,
        attemptId: "attempt-stable",
        sessionId,
      }),
      fixedTime + 4,
      signal,
    );
    await runtime.setDefaultBinding(
      scope,
      sessionId,
      new CreateSessionBindingRequest(
        "binding-b",
        "runtime-b",
        "claude-code",
        "workspace-b",
        2,
      ),
      fixedTime + 5,
      signal,
    );
    await expect(
      runtime.commitEvent(
        scope,
        "runtime-a",
        decodeSessionEventEnvelope(
          JSON.stringify({
            eventId: "stable-after-rebind",
            kind: SESSION_EVENT_KIND,
            payload: JSON.stringify({
              commandId: request.commandId,
              kind: AGENT_MESSAGE_DELTA_KIND,
              sessionId,
              text: "still owned by runtime-a",
            }),
            sessionId,
            source: {
              attemptId: "attempt-stable",
              kind: "attempt",
              sourceSeq: "2",
            },
          }),
        ),
        fixedTime + 5,
        signal,
      ),
    ).resolves.toMatchObject({ duplicate: false });
    await expect(
      runtime.readTurn(scope, sessionId, accepted.turn.turnId, signal),
    ).resolves.toMatchObject({
      bindingId: "binding-a",
      state: { kind: "running" },
      turnId: accepted.turn.turnId,
    });
    await expect(
      runtime.readAttempt(scope, sessionId, "attempt-stable", signal),
    ).resolves.toMatchObject({
      attemptId: "attempt-stable",
      bindingId: "binding-a",
      turnId: accepted.turn.turnId,
    });

    await runtime.markRuntimeDisconnected(
      scope,
      "runtime-a",
      fixedTime + 6,
      signal,
    );
    await expect(
      runtime.readAttempt(scope, sessionId, "attempt-stable", signal),
    ).resolves.toMatchObject({
      attemptId: "attempt-stable",
      state: { kind: "indeterminate" },
    });
    await expect(
      runtime.acceptTurn(
        scope,
        "runtime-b",
        {
          ...prompt(sessionId, "submit-b", "start overlapping work"),
          agentId: "claude-code",
          bindingId: "binding-b",
          directoryId: "workspace-b",
        },
        fixedTime + 7,
        signal,
      ),
    ).rejects.toMatchObject({ code: "session_busy" });
    await runtime.reconcileAttempt(
      scope,
      "runtime-a",
      sessionId,
      "attempt-stable",
      {
        kind: "failed",
        error: {
          code: "runtime_restarted",
          message: "The Runtime confirmed that the execution stopped",
          retryable: true,
        },
      },
      fixedTime + 8,
      signal,
    );
    await expect(
      runtime.acceptTurn(
        scope,
        "runtime-b",
        {
          ...prompt(sessionId, "submit-b", "start after reconciliation"),
          agentId: "claude-code",
          bindingId: "binding-b",
          directoryId: "workspace-b",
        },
        fixedTime + 9,
        signal,
      ),
    ).resolves.toMatchObject({ kind: "accepted" });
    runtime.close();
  });

  it("Given a used Session binding, When the Agent applies a configuration update, Then future Turns use a new revision while the accepted Turn stays pinned", async () => {
    const directory = await temporaryDirectory();
    const runtime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
    );
    const scope = new ProjectScope("tenant-a", "project-a");
    const signal = new AbortController().signal;
    const sessionId = "configured-session";
    await runtime.createSession(
      scope,
      new CreateSessionRequest(
        sessionId,
        "runtime-a",
        "codex",
        "binding-a",
        "workspace-a",
        new SessionRecordingPolicy("full", 86_400_000, 10, 100_000),
      ),
      fixedTime,
      signal,
    );
    const first = {
      ...prompt(sessionId, "configuration-turn-a", "before configuration"),
      bindingId: "binding-a",
      directoryId: "workspace-a",
    };
    const accepted = await runtime.acceptTurn(
      scope,
      "runtime-a",
      first,
      fixedTime + 1,
      signal,
    );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "configuration-started", {
        attemptId: "configuration-attempt-a",
        commandId: first.commandId,
        kind: SESSION_STARTED_KIND,
        sessionId,
      }),
      fixedTime + 2,
      signal,
    );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "configuration-completed", {
        commandId: first.commandId,
        kind: SESSION_COMPLETED_KIND,
        sessionId,
        stopReason: "end_turn",
      }),
      fixedTime + 3,
      signal,
    );

    const configuration = envelope(sessionId, "configuration-updated", {
      configOptions: [],
      kind: SESSION_CONFIG_UPDATED_KIND,
      requestId: "configuration-binding-b",
      sessionId,
    });
    await expect(
      runtime.commitEvent(
        scope,
        "runtime-a",
        configuration,
        fixedTime + 4,
        signal,
      ),
    ).resolves.toMatchObject({ duplicate: false });
    await expect(
      runtime.commitEvent(
        scope,
        "runtime-a",
        configuration,
        fixedTime + 5,
        signal,
      ),
    ).resolves.toMatchObject({ duplicate: true });

    await expect(
      runtime.readSession(scope, sessionId, signal),
    ).resolves.toMatchObject({
      defaultBinding: {
        bindingId: "configuration-binding-b",
        configRevision: 2,
      },
    });
    await expect(
      runtime.readTurn(scope, sessionId, accepted.turn.turnId, signal),
    ).resolves.toMatchObject({ bindingId: "binding-a" });
    await expect(
      runtime.acceptTurn(
        scope,
        "runtime-a",
        {
          ...prompt(sessionId, "configuration-turn-b", "after configuration"),
          bindingId: "configuration-binding-b",
          directoryId: "workspace-a",
        },
        fixedTime + 6,
        signal,
      ),
    ).resolves.toMatchObject({
      kind: "accepted",
      turn: { bindingId: "configuration-binding-b" },
    });
    runtime.close();
  });

  it("Given a reconnect and a large recorded activity, When events are retransmitted and archive work resumes, Then catch-up is ordered, deduplicated, and full detail remains readable", async () => {
    const directory = await temporaryDirectory();
    const database = new NodeSqlDatabase(join(directory, "relay.sqlite"));
    const files = new FilesystemContentStore(join(directory, "content"));
    const runtime = new SqliteSessionRuntime(
      database,
      new FailAfterFirstWriteStore(files),
    );
    const scope = new ProjectScope("tenant-a", "project-a");
    const sessionId = "session-a";
    const command = prompt(sessionId, "command-a", "inspect the repository");
    const signal = new AbortController().signal;
    await runtime.createSession(
      scope,
      new CreateSessionRequest(
        sessionId,
        "runtime-a",
        "codex",
        "workspace",
        "root",
        new SessionRecordingPolicy("full", 86_400_000, 10, 2_000_000),
        "Repository inspection",
      ),
      fixedTime,
      signal,
    );
    await expect(
      runtime.acceptTurn(scope, "runtime-a", command, fixedTime, signal),
    ).resolves.toMatchObject({ kind: "accepted" });
    await expect(
      runtime.acceptTurn(scope, "runtime-a", command, fixedTime, signal),
    ).resolves.toMatchObject({ kind: "duplicate", state: "queued" });

    const started = envelope(sessionId, "event-started", {
      commandId: command.commandId,
      kind: SESSION_STARTED_KIND,
      attemptId: "attempt-a",
      sessionId,
    });
    const firstCommit = await runtime.commitEvent(
      scope,
      "runtime-a",
      started,
      fixedTime + 1,
      signal,
    );
    await expect(
      runtime.commitEvent(scope, "runtime-a", started, fixedTime + 2, signal),
    ).resolves.toEqual({ ...firstCommit, duplicate: true });

    const fullOutput = `begin-${"large tool output\n".repeat(35_000)}-end`;
    const activity = envelope(sessionId, "event-activity", {
      activityId: "activity-a",
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
      output: `${fullOutput.slice(0, 24_000)}`,
      sequence: 0,
      sessionId,
      status: "completed",
      title: "Run terminal command",
      toolKind: "execute",
    });
    await runtime.commitEvent(
      scope,
      "runtime-a",
      activity,
      fixedTime + 3,
      signal,
    );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "event-delta", {
        commandId: command.commandId,
        kind: AGENT_MESSAGE_DELTA_KIND,
        sessionId,
        text: "done",
      }),
      fixedTime + 4,
      signal,
    );
    await runtime.commitEvent(
      scope,
      "runtime-a",
      envelope(sessionId, "event-completed", {
        commandId: command.commandId,
        kind: SESSION_COMPLETED_KIND,
        sessionId,
        stopReason: "end_turn",
      }),
      fixedTime + 5,
      signal,
    );

    const page = await runtime.readEvents(scope, sessionId, null, 2, signal);
    expect(page.events.map((event) => event.sequence)).toEqual(["1", "2"]);
    expect(page.hasMore).toBe(true);
    await expect(
      runtime.readEvents(scope, sessionId, page.cursor, 10, signal),
    ).resolves.toMatchObject({
      events: [{ sequence: "3" }, { sequence: "4" }],
      hasMore: false,
    });
    await expect(
      runtime.readToolCallDetail(
        scope,
        sessionId,
        "attempt-a",
        "activity-a",
        signal,
      ),
    ).resolves.toMatchObject({
      kind: "available",
      output: fullOutput,
      storage: "hot",
    });

    await expect(
      runtime.runArchiveWork(scope, sessionId, signal),
    ).rejects.toMatchObject({
      code: "session_storage_unavailable",
    });
    await expect(
      runtime.readToolCallDetail(
        scope,
        sessionId,
        "attempt-a",
        "activity-a",
        signal,
      ),
    ).resolves.toMatchObject({
      kind: "available",
      output: fullOutput,
      storage: "hot",
    });
    await runtime.runArchiveWork(scope, sessionId, signal);
    expect(runtime.hasPendingArchiveWork(scope, sessionId)).toBe(false);
    await expect(
      runtime.readToolCallDetail(
        scope,
        sessionId,
        "attempt-a",
        "activity-a",
        signal,
      ),
    ).resolves.toMatchObject({
      kind: "available",
      output: fullOutput,
      storage: "archive",
    });
    const exported = await runtime.exportSession(scope, sessionId, signal);
    expect(exported.toolCallViews).toEqual([
      expect.objectContaining({ eventSequence: "2" }),
    ]);
    const destination = new ProjectScope("tenant-b", "project-b");
    await runtime.importSession(destination, exported, fixedTime + 6, signal);
    await expect(
      runtime.readToolCallDetail(
        destination,
        sessionId,
        "attempt-a",
        "activity-a",
        signal,
      ),
    ).resolves.toMatchObject({
      kind: "available",
      output: fullOutput,
      storage: "hot",
    });
    await expect(
      runtime.readMessages(destination, sessionId, null, 10, signal),
    ).resolves.toMatchObject({
      messages: [
        expect.objectContaining({
          attempt: expect.objectContaining({ kind: "succeeded" }),
          response: "done",
        }),
      ],
    });
    database.close();
  });

  it("Given isolated tenants and retained records, When sessions are exported, imported, expired, and deleted, Then ownership and lifecycle outcomes stay explicit", async () => {
    const directory = await temporaryDirectory();
    const runtime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
    );
    const source = new ProjectScope("tenant-a", "project-a");
    const destination = new ProjectScope("tenant-b", "project-b");
    const signal = new AbortController().signal;
    await runtime.createSession(
      source,
      new CreateSessionRequest(
        "portable-session",
        "runtime-a",
        "codex",
        "workspace",
        "root",
        new SessionRecordingPolicy("full", 86_400_000, 10, 100_000),
      ),
      fixedTime,
      signal,
    );
    await expect(
      runtime.readSession(destination, "portable-session", signal),
    ).rejects.toMatchObject({ code: "session_not_found" });

    const exported = await runtime.exportSession(
      source,
      "portable-session",
      signal,
    );
    await runtime.importSession(destination, exported, fixedTime + 1, signal);
    await expect(
      runtime.importSession(destination, exported, fixedTime + 2, signal),
    ).rejects.toMatchObject({ code: "session_conflict" });
    await expect(
      runtime.readSession(destination, "portable-session", signal),
    ).resolves.toMatchObject({
      projectId: "project-b",
      sessionId: "portable-session",
    });
    await expect(
      runtime.deleteSession(
        destination,
        "portable-session",
        fixedTime + 3,
        signal,
      ),
    ).resolves.toEqual({
      completedAt: new Date(fixedTime + 3).toISOString(),
      kind: "deleted",
    });
    await expect(
      runtime.readMessages(destination, "portable-session", null, 10, signal),
    ).rejects.toMatchObject({ code: "session_deleted" });
    await expect(
      runtime.readToolCallDetail(
        destination,
        "portable-session",
        "missing-attempt",
        "missing-activity",
        signal,
      ),
    ).resolves.toMatchObject({ kind: "deleted" });
    expect(SessionRuntimeError).toBeDefined();
    runtime.close();
  });

  it("Given a session whose earliest payloads moved to immutable archives, When it is exported and imported, Then every durable cursor and final message remains complete", async () => {
    const directory = await temporaryDirectory();
    const runtime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
    );
    const source = new ProjectScope("tenant-a", "project-a");
    const destination = new ProjectScope("tenant-b", "project-b");
    const signal = new AbortController().signal;
    const sessionId = "pruned-session";
    await runtime.createSession(
      source,
      new CreateSessionRequest(
        sessionId,
        "runtime-a",
        "codex",
        "workspace",
        "root",
        new SessionRecordingPolicy("full", 86_400_000, 10, 100_000),
      ),
      fixedTime,
      signal,
    );

    for (let index = 0; index < 15; index += 1) {
      const command = prompt(
        sessionId,
        `command-${index.toString()}`,
        `prompt ${index.toString()}`,
      );
      await runtime.acceptTurn(
        source,
        "runtime-a",
        command,
        fixedTime + index * 4 + 1,
        signal,
      );
      await runtime.commitEvent(
        source,
        "runtime-a",
        envelope(sessionId, `started-${index.toString()}`, {
          commandId: command.commandId,
          kind: SESSION_STARTED_KIND,
          attemptId: `attempt-${index.toString()}`,
          sessionId,
        }),
        fixedTime + index * 4 + 2,
        signal,
      );
      await runtime.commitEvent(
        source,
        "runtime-a",
        envelope(sessionId, `delta-${index.toString()}`, {
          commandId: command.commandId,
          kind: AGENT_MESSAGE_DELTA_KIND,
          sessionId,
          text: `answer ${index.toString()}`,
        }),
        fixedTime + index * 4 + 3,
        signal,
      );
      await runtime.commitEvent(
        source,
        "runtime-a",
        envelope(sessionId, `completed-${index.toString()}`, {
          commandId: command.commandId,
          kind: SESSION_COMPLETED_KIND,
          sessionId,
          stopReason: "end_turn",
        }),
        fixedTime + index * 4 + 4,
        signal,
      );
      if ((index + 1) % 5 === 0) {
        await runtime.runArchiveWork(source, sessionId, signal);
      }
    }
    await runtime.runArchiveWork(source, sessionId, signal);
    await runtime.runArchiveWork(source, sessionId, signal);
    const exported = await runtime.exportSession(source, sessionId, signal);
    expect(exported.minimumSequence).toBe("1");
    expect(exported.events[0]?.sequence).toBe(exported.minimumSequence);

    await runtime.importSession(destination, exported, fixedTime + 100, signal);
    const messages = await runtime.readMessages(
      destination,
      sessionId,
      null,
      100,
      signal,
    );
    expect(messages.messages).toHaveLength(15);
    expect(messages.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt: expect.objectContaining({ kind: "succeeded" }),
          prompt: "prompt 0",
          response: "answer 0",
        }),
      ]),
    );
    const events = await runtime.readEvents(
      destination,
      sessionId,
      null,
      100,
      signal,
    );
    expect(events.events[0]?.sequence).toBe(exported.minimumSequence);
    expect(events.events.at(-1)?.sequence).toBe(
      (BigInt(exported.nextSequence) - 1n).toString(),
    );
    runtime.close();
  });

  it("Given configured tenant and project quotas, When active sessions reach capacity and one is deleted, Then admission is isolated and capacity is recovered", async () => {
    const directory = await temporaryDirectory();
    const runtime = new NodeSessionRuntime(
      join(directory, "relay.sqlite"),
      join(directory, "content"),
      new SessionQuotaPolicy(2, 1),
    );
    const signal = new AbortController().signal;
    const tenantProjectA = new ProjectScope("tenant-a", "project-a");
    const tenantProjectB = new ProjectScope("tenant-a", "project-b");
    const otherTenant = new ProjectScope("tenant-b", "project-a");
    const create = (scope: ProjectScope, sessionId: string) =>
      runtime.createSession(
        scope,
        new CreateSessionRequest(
          sessionId,
          "runtime-a",
          "codex",
          "workspace",
          "root",
          new SessionRecordingPolicy("summary", 86_400_000, 10, 100_000),
        ),
        fixedTime,
        signal,
      );

    await create(tenantProjectA, "project-a-first");
    await expect(
      create(tenantProjectA, "project-a-over-quota"),
    ).rejects.toMatchObject({ code: "session_quota_exceeded" });
    await create(tenantProjectB, "project-b-first");
    await expect(
      create(new ProjectScope("tenant-a", "project-c"), "tenant-over-quota"),
    ).rejects.toMatchObject({ code: "session_quota_exceeded" });
    await expect(
      create(otherTenant, "other-tenant-first"),
    ).resolves.toMatchObject({
      sessionId: "other-tenant-first",
    });

    await runtime.deleteSession(
      tenantProjectA,
      "project-a-first",
      fixedTime + 1,
      signal,
    );
    await expect(
      create(tenantProjectA, "project-a-after-delete"),
    ).resolves.toMatchObject({ sessionId: "project-a-after-delete" });
    runtime.close();
  });
});
