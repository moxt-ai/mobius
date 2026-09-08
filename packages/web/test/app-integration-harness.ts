import {
  decodeMessageKind,
  decodeSessionEventAcknowledgement,
  decodeSessionPromptCommand,
  decodeSessionStartedEvent,
  encodeAgentMessageDeltaEvent,
  encodeSessionCompletedEvent,
  encodeSessionEventEnvelope,
  encodeSessionReadyEvent,
  encodeSessionStartedEvent,
  MOBIUS_API_PREFIX,
  SESSION_EVENT_ACK_KIND,
  SESSION_EVENT_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
  type SessionConfigOption,
  type SessionPrepareCommand,
} from "@moxt-ai/mobius-protocol";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, expect } from "vitest";
import type { AgentOption, InstallableAgentOption } from "@/domain/channel";
import { closeMobiusTransport } from "@/services/mobius-transport";
import { startLocalRelay } from "./relay-harness.ts";

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
  ): Promise<string> => {
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
    return acknowledgement.sequence;
  };
}

export interface PairDaemonOptions {
  readonly agents?: readonly AgentOption[];
  readonly installableAgents?: readonly InstallableAgentOption[];
}

export async function pairDaemon(options: PairDaemonOptions = {}): Promise<{
  readonly channelId: string;
  readonly credential: CreatedPairing;
  readonly daemon: StatefulDaemon;
}> {
  const createdResponse = await fetch(
    new URL(`${MOBIUS_API_PREFIX}/pairings`, window.location.origin),
    { method: "POST" },
  );
  expect(createdResponse.status).toBe(201);
  const created = decodeCreatedPairing(await createdResponse.json());
  const claimResponse = await fetch(
    new URL(`${MOBIUS_API_PREFIX}/pairings/claim`, window.location.origin),
    {
      body: JSON.stringify({
        agents: options.agents ?? [
          {
            agentPath: "/usr/local/bin/codex",
            agentVersion: "codex 0.153.0",
            id: "codex",
            label: "Codex",
          },
        ],
        installableAgents: options.installableAgents ?? [],
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
    `${MOBIUS_API_PREFIX}/channels/${claimed.channelId}/daemon`,
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

export function saveBrowserCredential(
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

export async function sendReadySession(
  daemon: StatefulDaemon,
  prepare: SessionPrepareCommand,
  configOptions: readonly SessionConfigOption[] = [],
): Promise<void> {
  await daemon.sendSessionEvent(
    prepare.sessionId,
    encodeSessionReadyEvent({
      additionalDirectories: prepare.additionalDirectoryIds.map(
        (directoryId) => ({ directoryId, name: directoryId }),
      ),
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
      configOptions,
      directoryId: prepare.directoryId,
      directoryLabel: "mobius",
      kind: "session.ready",
      requestId: prepare.requestId,
      restored: false,
      sessionId: prepare.sessionId,
    }),
  );
}

export async function completeRenderedPrompt(
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

export function setupWebIntegrationEnvironment(): void {
  let closeRelay = (): Promise<void> => Promise.resolve();

  beforeAll(async () => {
    const relay = await startLocalRelay();
    closeRelay = relay.close;
    setHappyDomUrl(relay.url);
  });

  afterAll(async () => {
    cleanup();
    await closeMobiusTransport();
    await closeRelay();
  });
}
