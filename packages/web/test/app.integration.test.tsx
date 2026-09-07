import {
  decodeMessageKind,
  decodeNativeSessionCommand,
  decodeSessionElicitationRespondCommand,
  decodeSessionEventAcknowledgement,
  decodeSessionPrepareCommand,
  decodeSessionPromptCommand,
  decodeSessionStartedEvent,
  encodeAgentActivityEvent,
  encodeAgentMessageDeltaEvent,
  encodeNativeSessionResult,
  encodeSessionCompletedEvent,
  encodeSessionConfigUpdatedEvent,
  encodeSessionElicitationRequestedEvent,
  encodeSessionElicitationResolvedEvent,
  encodeSessionEventEnvelope,
  encodeSessionInfoUpdatedEvent,
  encodeSessionReadyEvent,
  encodeSessionStartedEvent,
  encodeSessionUsageUpdatedEvent,
  NATIVE_SESSION_REQUEST_KIND,
  SESSION_ELICITATION_RESPOND_KIND,
  SESSION_EVENT_ACK_KIND,
  SESSION_EVENT_KIND,
  SESSION_PREPARE_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
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
  readonly #attemptIdsBySession = new Map<string, string>();
  readonly #messages: string[] = [];
  readonly #pending: PendingMessage[] = [];
  readonly #socket: WebSocket;
  readonly #sourceSequences = new Map<string, number>();

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
    if (decodeMessageKind(payload) === SESSION_STARTED_KIND) {
      this.#attemptIdsBySession.set(
        sessionId,
        decodeSessionStartedEvent(payload).attemptId,
      );
    }
    const attemptId = this.#attemptIdsBySession.get(sessionId);
    const sourceKey =
      attemptId === undefined
        ? `runtime:${sessionId}`
        : `attempt:${sessionId}:${attemptId}`;
    const sourceSequence = (this.#sourceSequences.get(sourceKey) ?? 0) + 1;
    this.#sourceSequences.set(sourceKey, sourceSequence);
    this.#socket.send(
      encodeSessionEventEnvelope({
        eventId,
        kind: SESSION_EVENT_KIND,
        payload,
        sessionId,
        source:
          attemptId === undefined
            ? { kind: "runtime", sourceSeq: sourceSequence.toString() }
            : {
                attemptId,
                kind: "attempt",
                sourceSeq: sourceSequence.toString(),
              },
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
    new URL("/api/pairings", window.location.origin),
    { method: "POST" },
  );
  expect(createdResponse.status).toBe(201);
  const created = decodeCreatedPairing(await createdResponse.json());
  const claimResponse = await fetch(
    new URL("/api/pairings/claim", window.location.origin),
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
    `/api/channels/${claimed.channelId}/daemon`,
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
      attemptId: crypto.randomUUID(),
      sessionId: prompt.sessionId,
    }),
  );
  await daemon.sendSessionEvent(
    prompt.sessionId,
    encodeAgentMessageDeltaEvent({
      commandId: prompt.commandId,
      kind: "agent.message.delta",
      sessionId: prompt.sessionId,
      text: responseText,
    }),
  );
  await daemon.sendSessionEvent(
    prompt.sessionId,
    encodeSessionCompletedEvent({
      commandId: prompt.commandId,
      kind: "session.completed",
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
  it("Given an owned paired Channel, When its one-time access link is opened in another browser, Then that browser receives revocable access without a Mobius account", async () => {
    const paired = await pairDaemon();
    const settingsPath = `/channels/${encodeURIComponent(paired.channelId)}/settings`;
    window.history.replaceState(null, "", settingsPath);
    window.localStorage.clear();
    saveBrowserCredential(paired.channelId, paired.credential);
    render(<App />);

    try {
      await screen.findByRole("heading", { name: "Agent settings" });
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Create one-time access link",
        }),
      );
      const accessLinkInput = await screen.findByRole("textbox", {
        name: "One-time access link",
      });
      const accessLink = accessLinkInput.getAttribute("value") ?? "";
      expect(accessLink).toContain(
        `/channels/${encodeURIComponent(paired.channelId)}#access=`,
      );
      expect(accessLink).not.toContain(paired.credential.hostToken);

      cleanup();
      await closeMobiusTransport();
      window.localStorage.clear();
      window.history.replaceState(null, "", accessLink);
      render(<App />);

      const linkedPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, linkedPreparation);
      await screen.findByRole("textbox", { name: "Message the local agent" });
      expect(window.location.hash).toBe("");
      const linkedCredential = window.localStorage.getItem(
        `mobius:channel-credential:${paired.channelId}`,
      );
      expect(linkedCredential).not.toBeNull();
      expect(linkedCredential).not.toContain(paired.credential.hostToken);

      cleanup();
      await closeMobiusTransport();
      window.localStorage.clear();
      saveBrowserCredential(paired.channelId, paired.credential);
      window.history.replaceState(null, "", settingsPath);
      render(<App />);

      const linkedDevices = await screen.findByRole("list", {
        name: "Linked devices",
      });
      expect(within(linkedDevices).getAllByRole("listitem")).toHaveLength(1);
      fireEvent.click(
        within(linkedDevices).getByRole("button", {
          name: /Revoke linked device/,
        }),
      );
      await waitFor(() => {
        expect(
          screen.getByText("No other devices currently have access."),
        ).toBeTruthy();
      });

      cleanup();
      await closeMobiusTransport();
      window.localStorage.clear();
      if (linkedCredential === null) {
        throw new Error("Expected a linked browser credential");
      }
      window.localStorage.setItem(
        `mobius:channel-credential:${paired.channelId}`,
        linkedCredential,
      );
      window.history.replaceState(null, "", settingsPath);
      render(<App />);

      expect(
        await screen.findByText(
          "unauthorized: A valid channel token is required",
        ),
      ).toBeTruthy();

      cleanup();
      await closeMobiusTransport();
      window.localStorage.clear();
      saveBrowserCredential(paired.channelId, paired.credential);
      window.history.replaceState(null, "", settingsPath);
      render(<App />);

      fireEvent.click(
        await screen.findByRole("button", {
          name: "Create one-time access link",
        }),
      );
      const renewedAccessLink = (
        await screen.findByRole("textbox", {
          name: "One-time access link",
        })
      ).getAttribute("value");
      if (renewedAccessLink === null) {
        throw new Error("Expected a renewed access link");
      }

      cleanup();
      await closeMobiusTransport();
      window.localStorage.setItem(
        `mobius:channel-credential:${paired.channelId}`,
        linkedCredential,
      );
      window.history.replaceState(null, "", renewedAccessLink);
      render(<App />);

      await screen.findByRole("textbox", { name: "Message the local agent" });
      expect(window.location.hash).toBe("");
      expect(
        window.localStorage.getItem(
          `mobius:channel-credential:${paired.channelId}`,
        ),
      ).not.toBe(linkedCredential);
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given a paired Agent has an unsent chat draft, When Agent settings is opened and closed, Then navigation stays in the page and preserves the draft", async () => {
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
      const sessionPath = `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(prepare.sessionId)}`;
      await waitFor(() => {
        expect(window.location.pathname).toBe(sessionPath);
      });
      fireEvent.change(promptInput, {
        target: { value: "Keep this draft while viewing settings" },
      });

      fireEvent.click(screen.getByRole("link", { name: "Agent settings" }));
      await screen.findByRole("heading", { level: 1, name: "Agent settings" });
      expect(window.location.pathname).toBe(`${sessionPath}/settings`);

      fireEvent.click(screen.getByRole("link", { name: "Back to chat" }));
      const restoredPromptInput = await screen.findByRole("textbox", {
        name: "Message the local agent",
      });
      expect(
        screen.getByDisplayValue("Keep this draft while viewing settings"),
      ).toBe(restoredPromptInput);
      expect(window.location.pathname).toBe(sessionPath);
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given one New chat already exists, When a user requests New chat from another conversation, Then the existing draft is reopened without creating another", async () => {
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
      const initialPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, initialPreparation);
      await completeRenderedPrompt(
        paired.daemon,
        "Existing conversation",
        "Existing response",
      );

      const sidebar = screen.getByRole("complementary", {
        name: "Conversation sidebar",
      });
      fireEvent.click(
        within(sidebar).getByRole("button", { name: /New chat.*⌘ N/ }),
      );
      const draftPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, draftPreparation);
      const draftPath = `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(draftPreparation.sessionId)}`;
      await waitFor(() => {
        expect(window.location.pathname).toBe(draftPath);
      });
      fireEvent.change(
        await screen.findByRole("textbox", {
          name: "Message the local agent",
        }),
        { target: { value: "Keep the existing New chat draft" } },
      );

      const conversations = screen.getByRole("navigation", {
        name: "Conversations",
      });
      fireEvent.click(
        within(conversations).getByRole("link", {
          name: /Existing conversation/,
        }),
      );
      await screen.findByRole("heading", {
        level: 1,
        name: "Existing conversation",
      });

      fireEvent.click(
        within(sidebar).getByRole("button", { name: /New chat.*⌘ N/ }),
      );

      await waitFor(() => {
        expect(window.location.pathname).toBe(draftPath);
      });
      expect(
        screen.getByDisplayValue("Keep the existing New chat draft"),
      ).toBeTruthy();
      expect(
        within(conversations).getAllByRole("link", { name: /New chat/ }),
      ).toHaveLength(1);
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

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
          attemptId: "attempt-1",
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
        directoryId: "saved-project",
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

  it("Given a native Session is opened, When the Web app reloads, Then its title and transcript are restored from the canonical Session", async () => {
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
      const initialPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, initialPreparation);
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
              entryId: "persistent-native-session",
              title: "Persistent native title",
              updatedAt: "2026-09-06T00:00:00.000Z",
            },
          ],
          kind: "native.session.result",
          nextCursor: null,
          requestId: listRequest.requestId,
          sessionId: listRequest.sessionId,
        }),
      );
      fireEvent.click(
        await within(sessionsDialog).findByRole("button", {
          name: "Open Persistent native title",
        }),
      );
      const openRequest = decodeNativeSessionCommand(
        await paired.daemon.receive(NATIVE_SESSION_REQUEST_KIND),
      );
      if (openRequest.action !== "import") {
        throw new Error("Expected a native Session import request");
      }
      const nativeHistory = {
        coveredCommandIds: [],
        messages: [
          { role: "user" as const, text: "Persisted native question" },
          { role: "assistant" as const, text: "Persisted native answer" },
        ],
        status: "available" as const,
        truncated: false,
      };
      paired.daemon.send(
        encodeNativeSessionResult({
          action: "import",
          history: nativeHistory,
          kind: "native.session.result",
          ready: {
            additionalDirectories: [],
            agentId: "codex",
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
            directoryId: openRequest.directoryId,
            directoryLabel: "/workspace/saved-project",
            kind: "session.ready",
            requestId: openRequest.requestId,
            restored: true,
            sessionId: openRequest.targetSessionId,
          },
          requestId: openRequest.requestId,
          sessionId: openRequest.sessionId,
          targetSessionId: openRequest.targetSessionId,
          title: "Persistent native title",
        }),
      );
      await screen.findByRole("heading", {
        level: 1,
        name: "Persistent native title",
      });
      await screen.findByText("Persisted native answer");
      expect(window.location.pathname).toBe(
        `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(openRequest.targetSessionId)}`,
      );

      cleanup();
      await closeMobiusTransport();
      render(<App />);
      const resumedPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      expect(resumedPreparation.sessionId).toBe(openRequest.targetSessionId);
      await sendReadySession(paired.daemon, resumedPreparation);

      await screen.findByRole("heading", {
        level: 1,
        name: "Persistent native title",
      });
      expect(await screen.findByText("Persisted native question")).toBeTruthy();
      expect(await screen.findByText("Persisted native answer")).toBeTruthy();
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given several persisted Sessions, When a user selects an older Session and reloads, Then its route and selection are restored", async () => {
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
      expect(window.location.pathname).toBe(
        `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(newerPreparation.sessionId)}`,
      );

      const conversations = await screen.findByRole("navigation", {
        name: "Conversations",
      });
      const conversationLinks = within(conversations).getAllByRole("link");
      expect(conversationLinks).toHaveLength(2);
      expect(conversationLinks[0]?.textContent).toContain(
        "Newest persisted prompt",
      );
      expect(conversationLinks[1]?.textContent).toContain(
        "Older persisted prompt",
      );
      fireEvent.click(
        within(conversations).getByRole("link", {
          name: /Older persisted prompt/,
        }),
      );
      await screen.findByRole("heading", {
        level: 1,
        name: "Older persisted prompt",
      });
      expect(window.location.pathname).toBe(
        `/channels/${encodeURIComponent(paired.channelId)}/sessions/${encodeURIComponent(olderPreparation.sessionId)}`,
      );

      cleanup();
      await closeMobiusTransport();
      render(<App />);
      const resumedPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      expect(resumedPreparation.sessionId).toBe(olderPreparation.sessionId);
      await sendReadySession(paired.daemon, resumedPreparation);

      const restoredConversations = await screen.findByRole("navigation", {
        name: "Conversations",
      });
      await waitFor(() => {
        const conversationButtons = within(restoredConversations).getAllByRole(
          "link",
        );
        expect(conversationButtons).toHaveLength(2);
        expect(conversationButtons[0]?.textContent).toContain(
          "Newest persisted prompt",
        );
        expect(conversationButtons[1]?.textContent).toContain(
          "Older persisted prompt",
        );
      });
      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
        "Older persisted prompt",
      );
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given a titled Session has no Turns, When the Web app reloads, Then the same Session remains visible and resumes preparation", async () => {
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
      const initialPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, initialPreparation);
      await paired.daemon.sendSessionEvent(
        initialPreparation.sessionId,
        encodeSessionInfoUpdatedEvent({
          kind: "session.info.updated",
          sessionId: initialPreparation.sessionId,
          title: "Prepared empty Session",
          updatedAt: "2026-09-06T12:00:00.000Z",
        }),
      );
      await screen.findByRole("heading", {
        level: 1,
        name: "Prepared empty Session",
      });

      cleanup();
      await closeMobiusTransport();
      render(<App />);
      const resumedPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      expect(resumedPreparation.sessionId).toBe(initialPreparation.sessionId);
      await sendReadySession(paired.daemon, resumedPreparation);

      const conversations = await screen.findByRole("navigation", {
        name: "Conversations",
      });
      expect(
        within(conversations).getByRole("link", {
          name: /Prepared empty Session/,
        }),
      ).toBeTruthy();
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });

  it("Given a prepared Session changes configuration, When the next Turn is sent and the page reloads, Then both use the new immutable binding", async () => {
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
      const initialPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      await sendReadySession(paired.daemon, initialPreparation);
      await paired.daemon.sendSessionEvent(
        initialPreparation.sessionId,
        encodeSessionConfigUpdatedEvent({
          configOptions: [
            {
              booleanValue: false,
              category: "model",
              currentValue: "configured",
              description: "Execution model",
              id: "model",
              name: "Model",
              type: "select",
              values: [
                {
                  description: "Configured model",
                  groupId: "models",
                  groupName: "Models",
                  name: "Configured",
                  value: "configured",
                },
              ],
            },
          ],
          kind: "session.config.updated",
          requestId: "configuration-binding",
          sessionId: initialPreparation.sessionId,
        }),
      );
      await screen.findByRole("button", {
        name: /Run settings: Configured/,
      });

      const promptInput = screen.getByRole("textbox", {
        name: "Message the local agent",
      });
      fireEvent.change(promptInput, {
        target: { value: "Use the configured binding" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      const prompt = decodeSessionPromptCommand(
        await paired.daemon.receive(SESSION_PROMPT_KIND),
      );
      expect(prompt.bindingId).toBe("configuration-binding");
      await paired.daemon.sendSessionEvent(
        prompt.sessionId,
        encodeSessionStartedEvent({
          attemptId: "configured-attempt",
          commandId: prompt.commandId,
          kind: "session.started",
          sessionId: prompt.sessionId,
        }),
      );
      await paired.daemon.sendSessionEvent(
        prompt.sessionId,
        encodeSessionCompletedEvent({
          commandId: prompt.commandId,
          kind: "session.completed",
          sessionId: prompt.sessionId,
          stopReason: "end_turn",
        }),
      );

      cleanup();
      await closeMobiusTransport();
      render(<App />);
      const resumedPreparation = decodeSessionPrepareCommand(
        await paired.daemon.receive(SESSION_PREPARE_KIND),
      );
      expect(resumedPreparation).toMatchObject({
        bindingId: "configuration-binding",
        sessionId: initialPreparation.sessionId,
      });
      await sendReadySession(paired.daemon, resumedPreparation);
    } finally {
      cleanup();
      await closeMobiusTransport();
      paired.daemon.close();
    }
  });
});
