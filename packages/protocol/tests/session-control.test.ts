import { describe, expect, it } from "vitest";

import {
  AGENT_CONTENT_KIND,
  type AgentContentEvent,
  type AgentDisplayContent,
  decodeAgentContentEvent,
  decodeSessionConfigureCommand,
  decodeSessionElicitationRequestedEvent,
  decodeSessionPermissionRequestedEvent,
  decodeSessionPrepareCommand,
  decodeSessionReadyEvent,
  decodeSessionUsageUpdatedEvent,
  decodeWorkspaceListCommand,
  encodeAgentContentEvent,
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

describe("ACP session control protocol", () => {
  it("Given an authorized directory handle, When a session is prepared, Then capabilities and dynamic configuration round-trip", () => {
    const command: SessionPrepareCommand = {
      additionalDirectoryIds: [],
      agentId: "codex",
      bindingId: "workspace",
      directoryId: "root",
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
      },
      commands: [],
      configOptions: [modelOption],
      directoryId: "root",
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
      directoryId: "root",
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
      directoryId: "root",
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
  it("Given a paired workspace, When the browser requests its root, Then it sends an opaque handle instead of a local path", () => {
    const command: WorkspaceListCommand = {
      bindingId: "workspace",
      directoryId: "root",
      kind: WORKSPACE_LIST_KIND,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: "directory-request-1",
    };

    expect(
      decodeWorkspaceListCommand(encodeWorkspaceListCommand(command)),
    ).toEqual(command);
  });
});
