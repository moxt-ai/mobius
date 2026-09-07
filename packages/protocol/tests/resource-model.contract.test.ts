import { describe, expect, it } from "vitest";
import {
  decodeArchiveSegment,
  decodeAttempt,
  decodeMessageView,
  decodeSession,
  decodeSessionBinding,
  decodeToolCallView,
  decodeTurn,
  transitionAttempt,
} from "../src/index.ts";

describe("Mobius resource model contract", () => {
  it("Given stable Session, binding, Turn, and Attempt resources, When their public records are decoded, Then lifecycle-specific data is accepted without infrastructure identities", () => {
    expect(
      decodeSession({
        createdAt: "2026-09-07T00:00:00.000Z",
        createdBy: "user-a",
        defaultBindingId: "binding-a",
        lastCommittedSeq: "1042",
        lifecycle: { kind: "ready" },
        projectId: "project-a",
        sessionId: "session-a",
        tenantId: "tenant-a",
      }),
    ).toMatchObject({
      lastCommittedSeq: "1042",
      lifecycle: { kind: "ready" },
      sessionId: "session-a",
    });
    expect(
      decodeSessionBinding({
        agentRef: "codex",
        bindingId: "binding-a",
        configRevision: 3,
        createdAt: "2026-09-07T00:00:00.000Z",
        runtimeId: "runtime-a",
        sessionId: "session-a",
        workspaceRef: "workspace-a",
      }),
    ).toMatchObject({ bindingId: "binding-a", configRevision: 3 });
    expect(
      decodeTurn({
        acceptedAt: "2026-09-07T00:00:01.000Z",
        bindingId: "binding-a",
        idempotencyKey: "submit-a",
        request: { content: "Inspect the repository", kind: "prompt" },
        sessionId: "session-a",
        state: { kind: "running", startedAt: "2026-09-07T00:00:02.000Z" },
        turnId: "turn-a",
      }),
    ).toMatchObject({ bindingId: "binding-a", turnId: "turn-a" });
    expect(
      decodeAttempt({
        attemptId: "attempt-a",
        bindingId: "binding-a",
        sessionId: "session-a",
        state: { kind: "running", startedAt: "2026-09-07T00:00:02.000Z" },
        turnId: "turn-a",
      }),
    ).toMatchObject({ attemptId: "attempt-a", turnId: "turn-a" });
  });

  it("Given lifecycle records from an untrusted boundary, When state-specific fields conflict, Then decoding rejects the illegal states", () => {
    expect(() =>
      decodeAttempt({
        attemptId: "attempt-a",
        bindingId: "binding-a",
        sessionId: "session-a",
        state: {
          completedAt: "2026-09-07T00:00:03.000Z",
          kind: "running",
          startedAt: "2026-09-07T00:00:02.000Z",
        },
        turnId: "turn-a",
      }),
    ).toThrow();
    expect(() =>
      decodeSession({
        createdAt: "2026-09-07T00:00:00.000Z",
        createdBy: "user-a",
        defaultBindingId: "binding-a",
        lastCommittedSeq: "1.5",
        lifecycle: { kind: "ready" },
        projectId: "project-a",
        sessionId: "session-a",
        tenantId: "tenant-a",
      }),
    ).toThrow();
  });

  it("Given bounded message, tool, and archive records, When the current schemas decode them, Then stable resource identities are accepted and unknown fields are rejected", () => {
    expect(
      decodeMessageView({
        contentArtifactIds: ["artifact-message"],
        lastAppliedSeq: "9007199254740993",
        messageId: "message-a",
        preview: "A bounded response",
        role: "agent",
        sessionId: "session-a",
        source: {
          attemptId: "attempt-a",
          kind: "attempt",
          turnId: "turn-a",
        },
        state: { completeness: { kind: "complete" }, kind: "available" },
      }),
    ).toMatchObject({ messageId: "message-a", role: "agent" });
    expect(
      decodeToolCallView({
        attemptId: "attempt-a",
        detail: { artifactId: "artifact-tool", kind: "available" },
        inputPreview: "{}",
        lastAppliedSeq: "9007199254740994",
        name: "read_file",
        outputPreview: "bounded",
        state: {
          completedAt: "2026-09-07T00:00:03.000Z",
          kind: "succeeded",
        },
        title: "Read file",
        toolCallId: "tool-a",
        toolKind: "read",
      }),
    ).toMatchObject({ attemptId: "attempt-a", toolCallId: "tool-a" });

    const archive = {
      compression: "gzip",
      eventCount: 2,
      firstSeq: "1",
      lastSeq: "2",
      segmentId: "segment-a",
      sessionId: "session-a",
      state: {
        byteLength: 128,
        kind: "published",
        publishedAt: "2026-09-07T00:00:04.000Z",
        sha256: "a".repeat(64),
      },
    } as const;
    expect(decodeArchiveSegment(archive)).toEqual(archive);
    expect(() => decodeArchiveSegment({ ...archive, unknown: true })).toThrow();
  });

  it("Given a terminal Attempt, When a caller requests a backward lifecycle transition, Then the explicit transition contract rejects it", () => {
    const attempt = decodeAttempt({
      attemptId: "attempt-terminal",
      bindingId: "binding-a",
      sessionId: "session-a",
      state: {
        completedAt: "2026-09-07T00:00:03.000Z",
        kind: "succeeded",
        result: { kind: "agent_result", stopReason: "end_turn" },
        startedAt: "2026-09-07T00:00:02.000Z",
      },
      turnId: "turn-a",
    });
    expect(() =>
      transitionAttempt(attempt, {
        kind: "running",
        startedAt: "2026-09-07T00:00:04.000Z",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_resource_transition" }),
    );
    expect(() =>
      transitionAttempt(attempt, {
        completedAt: "2026-09-07T00:00:04.000Z",
        kind: "succeeded",
        result: { kind: "agent_result", stopReason: "changed_result" },
        startedAt: "2026-09-07T00:00:02.000Z",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_resource_transition" }),
    );
  });
});
