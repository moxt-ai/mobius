import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENT_ACTIVITY_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  MOBIUS_PROTOCOL_VERSION,
  type RecordedSessionEvent,
  SESSION_COMPLETED_KIND,
  SESSION_EVENT_FORMAT_VERSION,
  SESSION_EVENT_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
  type SessionEventEnvelope,
  type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import {
  type ContentTarget,
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
      runtime.acceptCommand(scope, "runtime-a", command, fixedTime, signal),
    ).resolves.toEqual({ kind: "accepted" });
    await expect(
      runtime.acceptCommand(scope, "runtime-a", command, fixedTime, signal),
    ).resolves.toEqual({ kind: "duplicate", state: "accepted" });

    const started = envelope(sessionId, "event-started", {
      commandId: command.commandId,
      kind: SESSION_STARTED_KIND,
      processAttemptId: "attempt-a",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
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
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
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
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
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
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId,
        stopReason: "end_turn",
      }),
      fixedTime + 5,
      signal,
    );

    const page = await runtime.readEvents(scope, sessionId, null, 2, signal);
    expect(page.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(page.hasMore).toBe(true);
    await expect(
      runtime.readEvents(scope, sessionId, page.cursor, 10, signal),
    ).resolves.toMatchObject({
      events: [{ sequence: 3 }, { sequence: 4 }],
      hasMore: false,
    });
    await expect(
      runtime.readActivityDetail(scope, sessionId, "activity-a", signal),
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
      runtime.readActivityDetail(scope, sessionId, "activity-a", signal),
    ).resolves.toMatchObject({
      kind: "available",
      output: fullOutput,
      storage: "hot",
    });
    await runtime.runArchiveWork(scope, sessionId, signal);
    expect(runtime.hasPendingArchiveWork(scope, sessionId)).toBe(false);
    await expect(
      runtime.readActivityDetail(scope, sessionId, "activity-a", signal),
    ).resolves.toMatchObject({
      kind: "available",
      output: fullOutput,
      storage: "archive",
    });
    const exported = await runtime.exportSession(scope, sessionId, signal);
    const destination = new ProjectScope("tenant-b", "project-b");
    await runtime.importSession(destination, exported, fixedTime + 6, signal);
    await expect(
      runtime.readActivityDetail(destination, sessionId, "activity-a", signal),
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
          attempt: expect.objectContaining({ kind: "completed" }),
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
      runtime.readActivityDetail(
        destination,
        "portable-session",
        "missing-activity",
        signal,
      ),
    ).resolves.toMatchObject({ kind: "deleted" });
    expect(SessionRuntimeError).toBeDefined();
    runtime.close();
  });

  it("Given a session whose earliest events were archived out of the hot log, When it is exported and imported, Then retained cursors and final messages remain complete", async () => {
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
      await runtime.acceptCommand(
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
          processAttemptId: `attempt-${index.toString()}`,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
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
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
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
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
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
    expect(exported.minimumSequence).toBeGreaterThan(1);
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
          attempt: expect.objectContaining({ kind: "completed" }),
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
    expect(events.events.at(-1)?.sequence).toBe(exported.nextSequence - 1);
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
