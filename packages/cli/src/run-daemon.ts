import { randomUUID } from "node:crypto";

import {
  AGENT_ACTIVITY_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  decodeMessageKind,
  decodeSessionCancelCommand,
  decodeSessionPromptCommand,
  encodeAgentActivityEvent,
  encodeAgentMessageDeltaEvent,
  encodeSessionCompletedEvent,
  encodeSessionFailedEvent,
  encodeSessionStartedEvent,
  MOBIUS_PROTOCOL_VERSION,
  SESSION_CANCEL_KIND,
  SESSION_COMPLETED_KIND,
  SESSION_FAILED_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
  type SessionCancelCommand,
  type SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";
import { type MessageEvent, WebSocket } from "undici";

import { AcpSessionManager } from "./acp/session-manager.ts";
import type { AuditStore } from "./audit/audit-store.ts";
import { authorizeBinding } from "./authorization/authorize-binding.ts";
import { type DaemonConfig, findLocalAgent } from "./config.ts";
import { connectRelay } from "./relay-connection/connect.ts";

const RELAY_RECONNECT_DELAY_MILLISECONDS = 500;

class ActiveDaemonTurn {
  readonly command: SessionPromptCommand;
  readonly #connectionController: AbortController;
  #cancellationRequested = false;

  constructor(
    command: SessionPromptCommand,
    connectionController: AbortController,
  ) {
    this.command = command;
    this.#connectionController = connectionController;
  }

  readonly abortConnection = (): void => {
    this.#connectionController.abort();
  };

  readonly matches = (cancellation: SessionCancelCommand): boolean =>
    cancellation.commandId === this.command.commandId &&
    cancellation.sessionId === this.command.sessionId;

  readonly requestCancellation = (): boolean => {
    if (this.#cancellationRequested) {
      return false;
    }
    this.#cancellationRequested = true;
    return true;
  };

  get signal(): AbortSignal {
    return this.#connectionController.signal;
  }
}

function send(socket: WebSocket, message: string): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("Relay connection is not open");
  }
  socket.send(message);
}

function reportFailure(
  socket: WebSocket,
  command: SessionPromptCommand,
  code: string,
  message: string,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  send(
    socket,
    encodeSessionFailedEvent({
      code,
      commandId: command.commandId,
      kind: SESSION_FAILED_KIND,
      message,
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      sessionId: command.sessionId,
    }),
  );
}

async function executePrompt(
  socket: WebSocket,
  command: SessionPromptCommand,
  config: DaemonConfig,
  audit: AuditStore,
  sessions: AcpSessionManager,
  signal: AbortSignal,
): Promise<void> {
  try {
    const approvedRoot = await authorizeBinding(
      command.bindingId,
      config.bindingId,
      config.approvedRoot,
    );
    const agent = findLocalAgent(config.agents, command.agentId);
    const processAttemptId = randomUUID();
    audit.record({
      commandId: command.commandId,
      event: "session_authorized",
      sessionId: command.sessionId,
    });
    send(
      socket,
      encodeSessionStartedEvent({
        commandId: command.commandId,
        kind: SESSION_STARTED_KIND,
        processAttemptId,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: command.sessionId,
      }),
    );

    const result = await sessions.runPrompt({
      agent,
      cwd: approvedRoot,
      onActivity: (activity) => {
        send(
          socket,
          encodeAgentActivityEvent({
            activityId: activity.activityId,
            activityType: activity.activityType,
            commandId: command.commandId,
            input: activity.input,
            kind: AGENT_ACTIVITY_KIND,
            locations: activity.locations,
            name: activity.name,
            output: activity.output,
            protocolVersion: MOBIUS_PROTOCOL_VERSION,
            sequence: activity.sequence,
            sessionId: command.sessionId,
            status: activity.status,
            title: activity.title,
            toolKind: activity.toolKind,
          }),
        );
        return Promise.resolve();
      },
      onText: (text) => {
        send(
          socket,
          encodeAgentMessageDeltaEvent({
            commandId: command.commandId,
            kind: AGENT_MESSAGE_DELTA_KIND,
            protocolVersion: MOBIUS_PROTOCOL_VERSION,
            sessionId: command.sessionId,
            text,
          }),
        );
        return Promise.resolve();
      },
      prompt: command.prompt,
      sessionId: command.sessionId,
      signal,
    });

    send(
      socket,
      encodeSessionCompletedEvent({
        commandId: command.commandId,
        kind: SESSION_COMPLETED_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: command.sessionId,
        stopReason: result.stopReason,
      }),
    );
    audit.record({
      commandId: command.commandId,
      event:
        result.stopReason === "cancelled"
          ? "session_cancelled"
          : "session_completed",
      sessionId: command.sessionId,
    });
  } catch (error) {
    audit.record({
      commandId: command.commandId,
      event: "session_failed",
      sessionId: command.sessionId,
    });
    reportFailure(
      socket,
      command,
      "agent_execution_failed",
      "The local agent could not complete the request",
    );
    console.error("Mobius daemon command failed", error);
  }
}

function waitForRelayRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(finish, RELAY_RECONNECT_DELAY_MILLISECONDS);

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }

    signal.addEventListener("abort", finish, { once: true });
  });
}

async function runRelayConnection(
  config: DaemonConfig,
  audit: AuditStore,
  sessions: AcpSessionManager,
  signal: AbortSignal,
): Promise<void> {
  const socket = await connectRelay(config.relayUrl, signal);
  const activeTurns = new Map<string, ActiveDaemonTurn>();

  await new Promise<void>((resolve, reject) => {
    let finished = false;

    const cleanup = (): void => {
      signal.removeEventListener("abort", stop);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("message", handleMessage);
      for (const turn of activeTurns.values()) {
        turn.abortConnection();
      }
      activeTurns.clear();
    };

    const resolveConnection = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      resolve();
    };

    const rejectConnection = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      reject(new Error("Relay WebSocket failed"));
    };

    const stop = (): void => {
      socket.close(1000, "Daemon stopped");
      resolveConnection();
    };

    signal.addEventListener("abort", stop, { once: true });
    const handleClose = (): void => {
      resolveConnection();
    };
    const handleError = (): void => {
      if (signal.aborted) {
        resolveConnection();
        return;
      }
      rejectConnection();
    };
    const handleMessage = (event: MessageEvent<unknown>): void => {
      const encoded: unknown = event.data;
      if (typeof encoded !== "string") {
        socket.close(1003, "Text message required");
        return;
      }

      try {
        const kind = decodeMessageKind(encoded);
        if (kind === SESSION_CANCEL_KIND) {
          const cancellation = decodeSessionCancelCommand(encoded);
          const turn = activeTurns.get(cancellation.commandId);
          if (turn === undefined || !turn.matches(cancellation)) {
            console.warn(
              "Mobius daemon ignored cancellation for an inactive turn",
            );
            return;
          }
          if (!turn.requestCancellation()) {
            return;
          }
          audit.record({
            commandId: cancellation.commandId,
            event: "session_cancellation_requested",
            sessionId: cancellation.sessionId,
          });
          void sessions.cancelPrompt(cancellation.sessionId).catch((error) => {
            console.error(
              "Mobius daemon could not cancel the agent turn",
              error,
            );
          });
          return;
        }
        if (kind !== SESSION_PROMPT_KIND) {
          socket.close(1008, "Unsupported protocol message");
          return;
        }
        const command = decodeSessionPromptCommand(encoded);
        if (activeTurns.has(command.commandId)) {
          reportFailure(
            socket,
            command,
            "duplicate_command",
            "The command is already running",
          );
          return;
        }

        const turn = new ActiveDaemonTurn(command, new AbortController());
        activeTurns.set(command.commandId, turn);
        void executePrompt(
          socket,
          command,
          config,
          audit,
          sessions,
          turn.signal,
        )
          .catch((error: unknown) => {
            console.error("Mobius daemon turn failed", error);
          })
          .finally(() => {
            activeTurns.delete(command.commandId);
          });
      } catch (error) {
        console.error("Mobius daemon rejected a message", error);
        socket.close(1008, "Invalid protocol message");
      }
    };
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);
    socket.addEventListener("message", handleMessage);

    if (signal.aborted) {
      stop();
    }
  });
}

export async function runDaemon(
  config: DaemonConfig,
  audit: AuditStore,
  signal: AbortSignal,
): Promise<void> {
  const sessions = new AcpSessionManager();
  let retryAnnounced = false;

  try {
    while (!signal.aborted) {
      try {
        await runRelayConnection(config, audit, sessions, signal);
        retryAnnounced = false;
      } catch {
        if (signal.aborted) {
          return;
        }
        if (!retryAnnounced) {
          console.warn("Mobius daemon is waiting for the relay");
          retryAnnounced = true;
        }
      }

      await waitForRelayRetry(signal);
    }
  } finally {
    await sessions.close();
  }
}
