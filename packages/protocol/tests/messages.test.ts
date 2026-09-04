import { describe, expect, it } from "vitest";

import {
  AGENT_ACTIVITY_KIND,
  type AgentActivityEvent,
  decodeAgentActivityEvent,
  decodeSessionCancelCommand,
  decodeSessionPromptCommand,
  encodeAgentActivityEvent,
  encodeSessionCancelCommand,
  encodeSessionPromptCommand,
  MOBIUS_PROTOCOL_VERSION,
  ProtocolMessageError,
  SESSION_CANCEL_KIND,
  SESSION_PROMPT_KIND,
  type SessionCancelCommand,
  type SessionPromptCommand,
} from "../src/index.ts";

describe("session prompt protocol", () => {
  it("round-trips a valid command", () => {
    const command: SessionPromptCommand = {
      agentId: "codex",
      bindingId: "workspace",
      commandId: "command-1",
      kind: SESSION_PROMPT_KIND,
      prompt: "hello from browser",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
    };

    expect(
      decodeSessionPromptCommand(encodeSessionPromptCommand(command)),
    ).toEqual(command);
  });

  it("rejects a remote working directory", () => {
    const encoded = JSON.stringify({
      agentId: "codex",
      bindingId: "workspace",
      commandId: "command-1",
      cwd: "/tmp/untrusted",
      kind: SESSION_PROMPT_KIND,
      prompt: "hello from browser",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
    });

    expect(() => decodeSessionPromptCommand(encoded)).toThrowError(
      ProtocolMessageError,
    );
  });
});

describe("session cancel protocol", () => {
  it("Given an active turn identity, When cancellation crosses the relay boundary, Then only that turn is addressed", () => {
    const command: SessionCancelCommand = {
      commandId: "command-1",
      kind: SESSION_CANCEL_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
    };

    expect(
      decodeSessionCancelCommand(encodeSessionCancelCommand(command)),
    ).toEqual(command);
  });

  it("Given cancellation contains a remote target override, When it is decoded, Then the untrusted field is rejected", () => {
    const encoded = JSON.stringify({
      commandId: "command-1",
      cwd: "/tmp/untrusted",
      kind: SESSION_CANCEL_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
    });

    expect(() => decodeSessionCancelCommand(encoded)).toThrowError(
      ProtocolMessageError,
    );
  });
});

describe("agent activity protocol", () => {
  it("Given a normalized tool update, When it crosses the relay boundary, Then every display field round-trips", () => {
    const activity: AgentActivityEvent = {
      activityId: "tool-1",
      activityType: "tool",
      commandId: "command-1",
      input: '{"command":"pnpm test"}',
      toolKind: "execute",
      locations: ["/workspace/package.json"],
      name: "exec_command",
      output: "Tests passed",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sequence: 2,
      sessionId: "session-1",
      status: "completed",
      kind: AGENT_ACTIVITY_KIND,
      title: "Run the test suite",
    };

    expect(
      decodeAgentActivityEvent(encodeAgentActivityEvent(activity)),
    ).toEqual(activity);
  });

  it("Given an activity has an unknown lifecycle state, When it is decoded, Then the untrusted event is rejected", () => {
    const encoded = JSON.stringify({
      activityId: "tool-1",
      activityType: "tool",
      commandId: "command-1",
      input: "",
      kind: AGENT_ACTIVITY_KIND,
      locations: [],
      name: "read_file",
      output: "",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sequence: 0,
      sessionId: "session-1",
      status: "surprising",
      title: "Read a file",
      toolKind: "read",
    });

    expect(() => decodeAgentActivityEvent(encoded)).toThrowError(
      ProtocolMessageError,
    );
  });
});
