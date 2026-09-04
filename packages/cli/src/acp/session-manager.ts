import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  type ActiveSession,
  type ClientConnection,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

import type { LocalAgentDefinition } from "../config.ts";
import {
  type AcpActivity,
  AcpActivityTracker,
  isProgressMessage,
} from "./activity.ts";
import { createAcpClient } from "./create-client.ts";

const PROCESS_STOP_TIMEOUT_MILLISECONDS = 1_000;

export interface AcpTurnOptions {
  readonly agent: LocalAgentDefinition;
  readonly cwd: string;
  readonly onActivity: (activity: AcpActivity) => Promise<void>;
  readonly onText: (text: string) => Promise<void>;
  readonly prompt: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export interface AcpPromptResult {
  readonly stopReason: string;
}

export class AcpExecutionError extends Error {
  readonly code = "acp_execution_failed";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "AcpExecutionError";
  }
}

function readableWebStream(
  input: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
  let streamOpen = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.on("data", (chunk: unknown) => {
        if (!streamOpen) {
          return;
        }
        if (chunk instanceof Uint8Array) {
          controller.enqueue(new Uint8Array(chunk));
          return;
        }
        streamOpen = false;
        controller.error(new Error("ACP process produced a non-binary chunk"));
      });
      input.once("end", () => {
        if (!streamOpen) {
          return;
        }
        streamOpen = false;
        controller.close();
      });
      input.once("error", (error) => {
        if (!streamOpen) {
          return;
        }
        streamOpen = false;
        controller.error(error);
      });
    },
    cancel() {
      streamOpen = false;
    },
  });
}

function writableWebStream(
  output: NodeJS.WritableStream,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        output.write(chunk, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  });
}

async function stopAgentProcess(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  child.stdin?.end();
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  try {
    await once(child, "exit", {
      signal: AbortSignal.timeout(PROCESS_STOP_TIMEOUT_MILLISECONDS),
    });
  } catch {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = (): void => {
      reject(signal.reason ?? new Error("ACP request was cancelled"));
    };
    signal.addEventListener("abort", rejectAbort, { once: true });
    if (signal.aborted) {
      rejectAbort();
    }
  });
}

class AcpProcessSession {
  readonly #agentId: string;
  readonly #child: ReturnType<typeof spawn>;
  readonly #connection: ClientConnection;
  readonly #processExit: Promise<void>;
  readonly #session: ActiveSession;
  #turnRunning = false;

  private constructor(
    agentId: string,
    child: ReturnType<typeof spawn>,
    connection: ClientConnection,
    session: ActiveSession,
    processExit: Promise<void>,
  ) {
    this.#agentId = agentId;
    this.#child = child;
    this.#connection = connection;
    this.#session = session;
    this.#processExit = processExit;
  }

  static async start(
    agent: LocalAgentDefinition,
    cwd: string,
    signal: AbortSignal,
  ): Promise<AcpProcessSession> {
    signal.throwIfAborted();
    const child = spawn(agent.command, [...agent.arguments], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[${agent.id}-acp] ${chunk}`);
    });

    const processExit = new Promise<void>((resolve) => {
      child.once("error", resolve);
      child.once("exit", resolve);
    });
    const stream = ndJsonStream(
      writableWebStream(child.stdin),
      readableWebStream(child.stdout),
    );
    const connection = createAcpClient().connect(stream);

    try {
      await Promise.race([
        connection.agent.request(
          methods.agent.initialize,
          {
            clientCapabilities: {},
            protocolVersion: PROTOCOL_VERSION,
          },
          { cancellationSignal: signal },
        ),
        processExit.then(() => {
          throw new AcpExecutionError("ACP agent exited during initialization");
        }),
        rejectWhenAborted(signal),
      ]);
      const session = await Promise.race([
        connection.agent
          .buildSession(cwd)
          .start({ cancellationSignal: signal }),
        processExit.then(() => {
          throw new AcpExecutionError(
            "ACP agent exited while starting a session",
          );
        }),
        rejectWhenAborted(signal),
      ]);
      return new AcpProcessSession(
        agent.id,
        child,
        connection,
        session,
        processExit,
      );
    } catch (error) {
      connection.close(error);
      await stopAgentProcess(child);
      throw new AcpExecutionError("ACP agent initialization failed", {
        cause: error,
      });
    }
  }

  readonly belongsTo = (agentId: string): boolean => this.#agentId === agentId;

  readonly cancel = async (): Promise<void> => {
    if (!this.#turnRunning) {
      return;
    }
    await this.#connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.#session.sessionId,
    });
  };

  readonly prompt = async (
    prompt: string,
    onActivity: (activity: AcpActivity) => Promise<void>,
    onText: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<AcpPromptResult> => {
    if (this.#turnRunning) {
      throw new AcpExecutionError(
        "Another prompt is already running in this conversation",
      );
    }
    this.#turnRunning = true;
    const activities = new AcpActivityTracker(onActivity);

    const runTurn = async (): Promise<AcpPromptResult> => {
      const completion = this.#session.prompt(prompt, {
        cancellationSignal: signal,
      });
      for (;;) {
        const message = await this.#session.nextUpdate();
        if (message.kind === "stop") {
          await completion;
          await activities.finish();
          return { stopReason: message.stopReason };
        }
        const update = message.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          if (update.content.type === "text") {
            if (isProgressMessage(update)) {
              await activities.recordNarrative(
                "progress",
                update.messageId ?? "current",
                update.content.text,
              );
            } else {
              await activities.finishNarrative();
              await onText(update.content.text);
            }
          }
          continue;
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
          if (update.content.type === "text") {
            await activities.recordNarrative(
              "reasoning",
              update.messageId ?? "current",
              update.content.text,
            );
          }
          continue;
        }
        if (update.sessionUpdate === "tool_call") {
          await activities.recordToolCall(update);
          continue;
        }
        if (update.sessionUpdate === "tool_call_update") {
          await activities.recordToolCallUpdate(update);
          continue;
        }
        if (update.sessionUpdate === "plan") {
          await activities.recordPlan(update);
          continue;
        }
        if (update.sessionUpdate === "plan_update") {
          await activities.recordPlanUpdate(update);
          continue;
        }
        if (update.sessionUpdate === "plan_removed") {
          await activities.removePlan(update);
        }
      }
    };

    try {
      return await Promise.race([
        runTurn(),
        this.#processExit.then(() => {
          throw new AcpExecutionError("ACP agent exited during a prompt");
        }),
        rejectWhenAborted(signal),
      ]);
    } catch (error) {
      await activities.finish();
      throw new AcpExecutionError("ACP agent execution failed", {
        cause: error,
      });
    } finally {
      this.#turnRunning = false;
    }
  };

  readonly close = async (): Promise<void> => {
    this.#session.dispose();
    this.#connection.close();
    await stopAgentProcess(this.#child);
  };
}

export class AcpSessionManager {
  readonly #activeSessionIds = new Set<string>();
  readonly #cancellationRequests = new Set<string>();
  readonly #sessions = new Map<string, AcpProcessSession>();

  readonly cancelPrompt = async (sessionId: string): Promise<void> => {
    this.#cancellationRequests.add(sessionId);
    const runtime = this.#sessions.get(sessionId);
    if (runtime !== undefined) {
      await runtime.cancel();
    }
  };

  readonly runPrompt = async (
    options: AcpTurnOptions,
  ): Promise<AcpPromptResult> => {
    if (this.#activeSessionIds.has(options.sessionId)) {
      throw new AcpExecutionError(
        "Another prompt is already running in this conversation",
      );
    }
    this.#activeSessionIds.add(options.sessionId);

    let runtime = this.#sessions.get(options.sessionId);
    if (runtime !== undefined && !runtime.belongsTo(options.agent.id)) {
      this.#activeSessionIds.delete(options.sessionId);
      throw new AcpExecutionError(
        "The agent cannot change after a conversation has started",
      );
    }
    try {
      if (this.#cancellationRequests.has(options.sessionId)) {
        return { stopReason: "cancelled" };
      }
      if (runtime === undefined) {
        runtime = await AcpProcessSession.start(
          options.agent,
          options.cwd,
          options.signal,
        );
        this.#sessions.set(options.sessionId, runtime);
      }
      if (this.#cancellationRequests.has(options.sessionId)) {
        return { stopReason: "cancelled" };
      }
      return await runtime.prompt(
        options.prompt,
        options.onActivity,
        options.onText,
        options.signal,
      );
    } catch (error) {
      if (runtime !== undefined) {
        this.#sessions.delete(options.sessionId);
        await runtime.close();
      }
      if (error instanceof AcpExecutionError) {
        throw error;
      }
      throw new AcpExecutionError("ACP agent execution failed", {
        cause: error,
      });
    } finally {
      this.#activeSessionIds.delete(options.sessionId);
      this.#cancellationRequests.delete(options.sessionId);
    }
  };

  readonly close = async (): Promise<void> => {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map(async (session) => await session.close()));
  };
}
