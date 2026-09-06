import {
  decodeMessageKind,
  decodeNativeSessionCommand,
  decodeSessionElicitationRespondCommand,
  decodeSessionEventAcknowledgement,
  decodeSessionPrepareCommand,
  decodeSessionPromptCommand,
  encodeAgentActivityEvent,
  encodeAgentMessageDeltaEvent,
  encodeNativeSessionResult,
  encodeSessionCompletedEvent,
  encodeSessionElicitationRequestedEvent,
  encodeSessionElicitationResolvedEvent,
  encodeSessionEventEnvelope,
  encodeSessionReadyEvent,
  encodeSessionStartedEvent,
  encodeSessionUsageUpdatedEvent,
  MOBIUS_PROTOCOL_VERSION,
  NATIVE_SESSION_REQUEST_KIND,
  SESSION_ELICITATION_RESPOND_KIND,
  SESSION_EVENT_ACK_KIND,
  SESSION_EVENT_FORMAT_VERSION,
  SESSION_EVENT_KIND,
  SESSION_PREPARE_KIND,
  SESSION_PROMPT_KIND,
  type SessionPrepareCommand,
} from "@moxt-ai/mobius-protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { App } from "@/app";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { type LocalRelay, startLocalRelay } from "./relay-harness.ts";

interface CreatedPairing {
  readonly channelId: string;
  readonly hostToken: string;
  readonly pairingCode: string;
  readonly projectId: string;
  readonly tenantId: string;
}

interface ClaimedPairing {
  readonly channelId: string;
  readonly daemonToken: string;
}

interface PendingMessage {
  readonly kind: string;
  readonly reject: (reason: Error) => void;
  readonly resolve: (message: string) => void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCreatedPairing(value: unknown): CreatedPairing {
  if (
    !isRecord(value) ||
    typeof value["channelId"] !== "string" ||
    typeof value["hostToken"] !== "string" ||
    typeof value["pairingCode"] !== "string" ||
    typeof value["projectId"] !== "string" ||
    typeof value["tenantId"] !== "string"
  ) {
    throw new Error("The relay returned invalid browser pairing credentials");
  }
  return {
    channelId: value["channelId"],
    hostToken: value["hostToken"],
    pairingCode: value["pairingCode"],
    projectId: value["projectId"],
    tenantId: value["tenantId"],
  };
}

function decodeClaimedPairing(value: unknown): ClaimedPairing {
  if (
    !isRecord(value) ||
    typeof value["channelId"] !== "string" ||
    typeof value["daemonToken"] !== "string"
  ) {
    throw new Error("The relay returned invalid daemon pairing credentials");
  }
  return {
    channelId: value["channelId"],
    daemonToken: value["daemonToken"],
  };
}

function setHappyDomUrl(url: URL): void {
  const api: unknown = Reflect.get(window, "happyDOM");
  if (!isRecord(api)) {
    throw new Error("The Web integration test requires Happy DOM");
  }
  const setURL = api["setURL"];
  if (typeof setURL !== "function") {
    throw new Error("The Happy DOM environment cannot change its URL");
  }
  Reflect.apply(setURL, api, [url.href]);
}

class StatefulDaemon {
  readonly #messages: string[] = [];
  readonly #pending: PendingMessage[] = [];
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const kind = decodeMessageKind(event.data);
      const pendingIndex = this.#pending.findIndex(
        (candidate) => candidate.kind === kind,
      );
      const pending =
        pendingIndex < 0 ? undefined : this.#pending.splice(pendingIndex, 1)[0];
      if (pending === undefined) {
        this.#messages.push(event.data);
        return;
      }
      pending.resolve(event.data);
    });
    socket.addEventListener("error", () => {
      for (const pending of this.#pending.splice(0)) {
        pending.reject(new Error("The local daemon WebSocket failed"));
      }
    });
  }

  static async connect(url: URL): Promise<StatefulDaemon> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.timeout(8_000);
      const cleanupListeners = (): void => {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
        signal.removeEventListener("abort", handleAbort);
      };
      const handleAbort = (): void => {
        cleanupListeners();
        reject(new Error("The local daemon WebSocket did not open"));
      };
      const handleError = (): void => {
        cleanupListeners();
        reject(new Error("The local daemon WebSocket failed while opening"));
      };
      const handleOpen = (): void => {
        cleanupListeners();
        resolve();
      };
      socket.addEventListener("open", handleOpen, { once: true });
      socket.addEventListener("error", handleError, { once: true });
      signal.addEventListener("abort", handleAbort, { once: true });
    });
    return new StatefulDaemon(socket);
  }

  readonly close = (): void => {
    this.#socket.close(1000, "Web integration complete");
  };

  readonly receive = (kind: string): Promise<string> => {
    const existingIndex = this.#messages.findIndex(
      (message) => decodeMessageKind(message) === kind,
    );
    if (existingIndex >= 0) {
      const message = this.#messages.splice(existingIndex, 1)[0];
      if (message === undefined) {
        return Promise.reject(new Error(`Missing queued ${kind} message`));
      }
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(8_000);
      const pending: PendingMessage = {
        kind,
        reject: (error) => {
          signal.removeEventListener("abort", handleAbort);
          reject(error);
        },
        resolve: (message) => {
          signal.removeEventListener("abort", handleAbort);
          resolve(message);
        },
      };
      const handleAbort = (): void => {
        const index = this.#pending.indexOf(pending);
        if (index >= 0) {
          this.#pending.splice(index, 1);
        }
        reject(new Error(`The local daemon did not receive ${kind}`));
      };
      this.#pending.push(pending);
      signal.addEventListener("abort", handleAbort, { once: true });
    });
  };

  readonly send = (message: string): void => {
    this.#socket.send(message);
  };

  readonly sendSessionEvent = async (
    sessionId: string,
    payload: string,
  ): Promise<void> => {
    const eventId = crypto.randomUUID();
    this.#socket.send(
      encodeSessionEventEnvelope({
        eventId,
        eventVersion: SESSION_EVENT_FORMAT_VERSION,
        kind: SESSION_EVENT_KIND,
        payload,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId,
      }),
    );
    const acknowledgement = decodeSessionEventAcknowledgement(
      await this.receive(SESSION_EVENT_ACK_KIND),
    );
    if (
      acknowledgement.eventId !== eventId ||
      acknowledgement.sessionId !== sessionId ||
      acknowledgement.duplicate
    ) {
      throw new Error(
        "The relay returned an invalid session event acknowledgement",
      );
    }
  };
}

async function pairDaemon(): Promise<{
  readonly channelId: string;
  readonly credential: CreatedPairing;
  readonly daemon: StatefulDaemon;
}> {
  const createdResponse = await fetch(
    new URL("/v1/pairings", window.location.origin),
    { method: "POST" },
  );
  expect(createdResponse.status).toBe(201);
  const created = decodeCreatedPairing(await createdResponse.json());
  const claimResponse = await fetch(
    new URL("/v1/pairings/claim", window.location.origin),
    {
      body: JSON.stringify({
        agents: [{ id: "codex", label: "Codex" }],
        installableAgents: [],
        machineName: "Integration machine",
        pairingCode: created.pairingCode,
        workspaceName: "mobius",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  expect(claimResponse.status).toBe(200);
  const claimed = decodeClaimedPairing(await claimResponse.json());
  const daemonUrl = new URL(
    `/v1/channels/${claimed.channelId}/daemon`,
    window.location.origin,
  );
  daemonUrl.protocol = "ws:";
  daemonUrl.searchParams.set("token", claimed.daemonToken);
  return {
    channelId: claimed.channelId,
    credential: created,
    daemon: await StatefulDaemon.connect(daemonUrl),
  };
}

function saveBrowserCredential(
  channelId: string,
  credential: CreatedPairing,
): void {
  expect(credential.channelId).toBe(channelId);
  window.localStorage.setItem(
    `mobius:channel-credential:${channelId}`,
    JSON.stringify({
      hostToken: credential.hostToken,
      projectId: credential.projectId,
      tenantId: credential.tenantId,
    }),
  );
}

async function sendReadySession(
  daemon: StatefulDaemon,
  prepare: SessionPrepareCommand,
): Promise<void> {
  await daemon.sendSessionEvent(
    prepare.sessionId,
    encodeSessionReadyEvent({
      additionalDirectories: [],
      agentId: prepare.agentId,
      agentName: "Codex",
      agentVersion: "integration",
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
        unstableForkSession: true,
      },
      commands: [],
      configOptions: [],
      directoryId: prepare.directoryId,
      directoryLabel: "mobius",
      kind: "session.ready",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      requestId: prepare.requestId,
      restored: false,
      sessionId: prepare.sessionId,
    }),
  );
}

async function completeRenderedPrompt(
  daemon: StatefulDaemon,
  promptText: string,
  responseText: string,
): Promise<void> {
  const promptInput = await screen.findByRole("textbox", {
    name: "Message the local agent",
  });
  await waitFor(() => {
    expect(promptInput.getAttribute("placeholder")).toContain(
      "Ask the local agent",
    );
  });
  fireEvent.change(promptInput, { target: { value: promptText } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  const prompt = decodeSessionPromptCommand(
    await daemon.receive(SESSION_PROMPT_KIND),
  );
  await daemon.sendSessionEvent(
    prompt.sessionId,
    encodeSessionStartedEvent({
      commandId: prompt.commandId,
      kind: "session.started",
      processAttemptId: crypto.randomUUID(),
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: prompt.sessionId,
    }),
  );
  await daemon.sendSessionEvent(
    prompt.sessionId,
    encodeAgentMessageDeltaEvent({
      commandId: prompt.commandId,
      kind: "agent.message.delta",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: prompt.sessionId,
      text: responseText,
    }),
  );
  await daemon.sendSessionEvent(
    prompt.sessionId,
    encodeSessionCompletedEvent({
      commandId: prompt.commandId,
      kind: "session.completed",
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: prompt.sessionId,
      stopReason: "end_turn",
    }),
  );
  await screen.findByText(responseText);
}

type RelayState =
  | { readonly status: "not-started" }
  | { readonly relay: LocalRelay; readonly status: "running" };

let relayState: RelayState = { status: "not-started" };

beforeAll(async () => {
  const relay = await startLocalRelay();
  relayState = { relay, status: "running" };
  setHappyDomUrl(relay.url);
});

afterAll(async () => {
  cleanup();
  await closeMobiusTransport();
  if (relayState.status === "running") {
    await relayState.relay.close();
  }
});

describe.sequential("Web application boundaries", () => {
  it("Given a paired local Agent, When a user answers its form and sends a prompt, Then the Web app exchanges protocol messages and renders the response safely", async () => {
    const paired = await pairDaemon();
    window.history.replaceState(
      null,
      "",
      `/channels/${encodeURIComponent(paired.channelId)}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      const prepare = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, prepare);

      const promptInput = await screen.findByRole("textbox", {
        name: "Message the local agent",
      });
      await waitFor(() => {
        expect(promptInput.getAttribute("placeholder")).toContain(
          "Ask the local agent",
        );
      });

      fireEvent.change(promptInput, {
        target: { value: "Review the integration boundary" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      const prompt = decodeSessionPromptCommand(
        await paired.daemon.receive(SESSION_PROMPT_KIND),
      );
      expect(prompt).toMatchObject({
        prompt: "Review the integration boundary",
        sessionId: prepare.sessionId,
      });
      await paired.daemon.sendSessionEvent(
        prompt.sessionId,
        encodeSessionStartedEvent({
          commandId: prompt.commandId,
          kind: "session.started",
          processAttemptId: "attempt-1",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId: prompt.sessionId,
        }),
      );

      await paired.daemon.sendSessionEvent(
        prompt.sessionId,
        encodeSessionElicitationRequestedEvent({
          accepted: false,
          commandId: prompt.commandId,
          elicitationId: "form-1",
          fields: [
            {
              defaultBooleanValue: false,
              defaultNumberValue: 0,
              defaultStringValue: "",
              description: "Optional count",
              format: "",
              hasDefaultValue: false,
              maximum: "",
              maximumLength: "",
              minimum: "",
              minimumLength: "",
              name: "count",
              options: [],
              pattern: "",
              required: false,
              title: "Count",
              type: "number",
            },
            {
              defaultBooleanValue: false,
              defaultNumberValue: 0,
              defaultStringValue: "bug",
              description: "",
              format: "",
              hasDefaultValue: true,
              maximum: "",
              maximumLength: "",
              minimum: "",
              minimumLength: "",
              name: "labels",
              options: [
                { description: "", label: "Bug", value: "bug" },
                {
                  description: "",
                  label: "Frontend",
                  value: "frontend",
                },
              ],
              pattern: "",
              required: false,
              title: "Labels",
              type: "select",
            },
          ],
          interactionId: "form-interaction",
          kind: "session.elicitation.requested",
          message: "Choose issue details",
          mode: "form",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId: prepare.sessionId,
          url: "",
        }),
      );
      const formDialog = await screen.findByRole("dialog", {
        name: "Agent information request",
      });
      const labels = within(formDialog).getByLabelText("Labels");
      expect(labels).toBeInstanceOf(HTMLSelectElement);
      if (!(labels instanceof HTMLSelectElement)) {
        throw new Error("Expected a select field");
      }
      expect(labels.value).toBe("bug");
      fireEvent.click(
        within(formDialog).getByRole("button", { name: "Continue" }),
      );
      const response = decodeSessionElicitationRespondCommand(
        await paired.daemon.receive(SESSION_ELICITATION_RESPOND_KIND),
      );
      expect(response).toMatchObject({
        action: "accept",
        content: '{"labels":"bug"}',
        interactionId: "form-interaction",
        sessionId: prepare.sessionId,
      });
      await paired.daemon.sendSessionEvent(
        response.sessionId,
        encodeSessionElicitationResolvedEvent({
          action: "accept",
          interactionId: response.interactionId,
          kind: "session.elicitation.resolved",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId: response.sessionId,
        }),
      );
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Agent information request" }),
        ).toBeNull();
      });
      await paired.daemon.sendSessionEvent(
        prompt.sessionId,
        encodeAgentActivityEvent({
          activityId: "tool-1",
          activityType: "tool",
          commandId: prompt.commandId,
          content: [],
          detail: { kind: "unrecorded" },
          input: '{"path":"package.json"}',
          kind: "agent.activity",
          locations: ["package.json"],
          name: "read_file",
          output: "workspace manifest",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sequence: 0,
          sessionId: prompt.sessionId,
          status: "completed",
          title: "Read workspace manifest",
          toolKind: "read",
        }),
      );
      await paired.daemon.sendSessionEvent(
        prompt.sessionId,
        encodeAgentMessageDeltaEvent({
          commandId: prompt.commandId,
          kind: "agent.message.delta",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId: prompt.sessionId,
          text: "Completed **safely**. [unsafe](javascript:alert(1)) <script>alert(1)</script>",
        }),
      );
      await paired.daemon.sendSessionEvent(
        prompt.sessionId,
        encodeSessionUsageUpdatedEvent({
          costAmount: 0.25,
          costCurrency: "USD",
          hasCost: true,
          kind: "session.usage.updated",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId: prompt.sessionId,
          size: 200_000,
          source: "context",
          used: 50_000,
        }),
      );
      await paired.daemon.sendSessionEvent(
        prompt.sessionId,
        encodeSessionCompletedEvent({
          commandId: prompt.commandId,
          kind: "session.completed",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId: prompt.sessionId,
          stopReason: "end_turn",
        }),
      );

      const agentMessage = await screen.findByRole("article", {
        name: "Message from Codex",
      });
      await waitFor(() => {
        expect(agentMessage.textContent).toContain("Completed safely");
        expect(agentMessage.textContent).toContain("Read workspace manifest");
      });
      expect(document.querySelector("script")).toBeNull();
      expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
      await waitFor(() => {
        const usage = document.querySelector('[aria-label^="Agent usage:"]');
        expect(usage?.getAttribute("aria-label")).toContain("25%");
        expect(usage?.getAttribute("aria-label")).toContain("$0.25 USD");
      });
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given an Agent has saved history with image references, When a user previews that session, Then the Web app shows only a safe recent transcript", async () => {
    const paired = await pairDaemon();
    window.history.replaceState(
      null,
      "",
      `/channels/${encodeURIComponent(paired.channelId)}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      const prepare = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, prepare);
      await screen.findByRole("textbox", {
        name: "Message the local agent",
      });
      const sessionsButton = await screen.findByRole("button", {
        name: "Local sessions",
      });
      await waitFor(() =>
        expect(sessionsButton.hasAttribute("disabled")).toBe(false),
      );
      fireEvent.click(sessionsButton);
      const sessionsDialog = await screen.findByRole("dialog", {
        name: "Local sessions",
      });
      fireEvent.click(
        within(sessionsDialog).getByRole("button", { name: "Codex" }),
      );

      const listRequest = decodeNativeSessionCommand(
        await paired.daemon.receive(NATIVE_SESSION_REQUEST_KIND),
      );
      expect(listRequest.action).toBe("list");
      paired.daemon.send(
        encodeNativeSessionResult({
          action: "list",
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
            unstableForkSession: true,
          },
          entries: [
            {
              additionalDirectories: [],
              directoryId: "saved-project",
              directoryLabel: "/workspace/saved-project",
              entryId: "saved-session",
              title: "Saved integration conversation",
              updatedAt: "2026-09-06T00:00:00.000Z",
            },
          ],
          kind: "native.session.result",
          nextCursor: null,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          requestId: listRequest.requestId,
          sessionId: listRequest.sessionId,
        }),
      );

      const savedSession = await within(sessionsDialog).findByRole("button", {
        name: "Open Saved integration conversation",
      });
      fireEvent.click(savedSession);
      const previewRequest = decodeNativeSessionCommand(
        await paired.daemon.receive(NATIVE_SESSION_REQUEST_KIND),
      );
      expect(previewRequest).toMatchObject({
        action: "import",
        entryId: "saved-session",
      });
      if (previewRequest.action !== "import") {
        throw new Error("Expected an import request for session preview");
      }
      const imageData =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      paired.daemon.send(
        encodeNativeSessionResult({
          action: "preview",
          entryId: "saved-session",
          history: {
            coveredCommandIds: [],
            messages: [
              { role: "user", text: "Older message outside the preview" },
              ...Array.from({ length: 9 }, (_, index) => ({
                role: "assistant" as const,
                text: `Recent answer ${index.toString()}`,
              })),
              {
                role: "user",
                text: `Selected image [@image](data:image/png;base64,${imageData}) [@image](https://example.com/private.png)`,
              },
            ],
            status: "available",
            truncated: false,
          },
          kind: "native.session.result",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          reason: "continuation_unavailable",
          requestId: previewRequest.requestId,
          sessionId: previewRequest.sessionId,
          targetSessionId: previewRequest.targetSessionId,
          title: "Saved integration conversation",
        }),
      );

      const history = await within(sessionsDialog).findByRole("region", {
        name: "Previous conversation history",
      });
      expect(history.textContent).toContain("Showing the last 10 messages");
      expect(history.textContent).not.toContain(
        "Older message outside the preview",
      );
      expect(history.textContent).toContain("Image unavailable");
      expect(history.textContent).not.toContain("private.png");
      expect(history.textContent).not.toContain("base64");
      const image = within(history).getByAltText("Image 1");
      expect(image.getAttribute("src")).toBe(
        `data:image/png;base64,${imageData}`,
      );
      expect(history.querySelector('img[src^="http"]')).toBeNull();
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given several persisted conversations, When the Web app reloads, Then the newest conversation stays first and active", async () => {
    const paired = await pairDaemon();
    window.history.replaceState(
      null,
      "",
      `/channels/${encodeURIComponent(paired.channelId)}`,
    );
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      const olderPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, olderPreparation);
      await completeRenderedPrompt(
        paired.daemon,
        "Older persisted prompt",
        "OLDER-RESPONSE",
      );

      fireEvent.click(
        within(
          screen.getByRole("complementary", {
            name: "Conversation sidebar",
          }),
        ).getByRole("button", { name: /New chat.*⌘ N/ }),
      );
      const newerPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, newerPreparation);
      await completeRenderedPrompt(
        paired.daemon,
        "Newest persisted prompt",
        "NEWEST-RESPONSE",
      );

      cleanup();
      await closeMobiusTransport();
      render(<App />);
      const resumedPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, resumedPreparation);

      const conversations = await screen.findByRole("navigation", {
        name: "Conversations",
      });
      await waitFor(() => {
        const conversationButtons =
          within(conversations).getAllByRole("button");
        expect(conversationButtons).toHaveLength(2);
        expect(conversationButtons[0]?.textContent).toContain(
          "Newest persisted prompt",
        );
        expect(conversationButtons[1]?.textContent).toContain(
          "Older persisted prompt",
        );
      });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
        "Newest persisted prompt",
      );
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });
});
