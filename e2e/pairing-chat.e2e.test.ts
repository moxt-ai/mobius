import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuditStore } from "../packages/cli/src/audit/audit-store.ts";
import {
  pairLocalMachine,
  resumeLocalMachine,
} from "../packages/cli/src/pairing/pair-local-machine.ts";
import { runDaemon } from "../packages/cli/src/run-daemon.ts";
import {
  AGENT_ACTIVITY_KIND,
  AGENT_MESSAGE_DELTA_KIND,
  decodeAgentActivityEvent,
  decodeAgentMessageDeltaEvent,
  decodeMessageKind,
  decodeRuntimeStatusEvent,
  decodeSessionCancelCommand,
  decodeSessionCompletedEvent,
  decodeSessionFailedEvent,
  decodeSessionPromptCommand,
  decodeSessionStartedEvent,
  encodeAgentActivityEvent,
  encodeAgentMessageDeltaEvent,
  encodeSessionCancelCommand,
  encodeSessionCompletedEvent,
  encodeSessionPromptCommand,
  encodeSessionStartedEvent,
  MOBIUS_PROTOCOL_VERSION,
  RUNTIME_STATUS_KIND,
  SESSION_CANCEL_KIND,
  SESSION_COMPLETED_KIND,
  SESSION_FAILED_KIND,
  SESSION_PROMPT_KIND,
  SESSION_STARTED_KIND,
} from "../packages/protocol/src/index.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fakeAgentPath = fileURLToPath(
  new URL("./fixtures/fake-acp-agent/src/cli.ts", import.meta.url),
);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

class BrowserPairingCredentials {
  readonly channelId: string;
  readonly pairingCode: string;

  constructor(channelId: string, pairingCode: string) {
    this.channelId = channelId;
    this.pairingCode = pairingCode;
  }
}

class BrowserPromptResult {
  readonly stopReason: string;
  readonly text: string;

  constructor(text: string, stopReason: string) {
    this.text = text;
    this.stopReason = stopReason;
  }
}

class ActiveBrowserPrompt {
  readonly commandId: string;
  readonly result: Promise<BrowserPromptResult>;

  constructor(commandId: string, result: Promise<BrowserPromptResult>) {
    this.commandId = commandId;
    this.result = result;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBrowserPairing(value: unknown): BrowserPairingCredentials {
  if (!isRecord(value)) {
    throw new Error("Invalid pairing response");
  }
  const channelId = value["channelId"];
  const pairingCode = value["pairingCode"];
  if (typeof channelId !== "string" || typeof pairingCode !== "string") {
    throw new Error("Invalid pairing response");
  }
  return new BrowserPairingCredentials(channelId, pairingCode);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve an E2E port");
  }
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function waitForRelay(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Wrangler did not start the relay in time\n${output}`));
    }, 10_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.removeListener("data", handleOutput);
      child.stderr?.removeListener("data", handleOutput);
      child.removeListener("exit", handleExit);
    };
    const handleOutput = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes("Ready on http://")) {
        cleanup();
        resolve();
      }
    };
    const handleExit = (): void => {
      cleanup();
      reject(new Error(`Wrangler exited before becoming ready\n${output}`));
    };
    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", handleOutput);
    child.once("exit", handleExit);
  });
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(3_000) });
  } catch {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
}

function waitForRuntimeOnline(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("The daemon did not come online"));
    }, 8_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("message", handleMessage);
    };
    const handleError = (): void => {
      cleanup();
      reject(new Error("The host WebSocket failed"));
    };
    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (typeof event.data !== "string") {
        return;
      }
      if (decodeMessageKind(event.data) !== RUNTIME_STATUS_KIND) {
        return;
      }
      if (decodeRuntimeStatusEvent(event.data).online) {
        cleanup();
        resolve();
      }
    };
    socket.addEventListener("error", handleError);
    socket.addEventListener("message", handleMessage);
  });
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("The WebSocket did not open"));
    }, 8_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
    };
    const handleOpen = (): void => {
      cleanup();
      resolve();
    };
    const handleError = (): void => {
      cleanup();
      reject(new Error("The WebSocket failed while opening"));
    };
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
  });
}

function waitForProtocolKind(
  socket: WebSocket,
  expectedKind: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Did not receive ${expectedKind}`));
    }, 8_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("error", handleError);
    };
    const handleError = (): void => {
      cleanup();
      reject(new Error("The WebSocket failed while waiting for a message"));
    };
    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (
        typeof event.data !== "string" ||
        decodeMessageKind(event.data) !== expectedKind
      ) {
        return;
      }
      cleanup();
      resolve(event.data);
    };
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", handleError);
  });
}

function startBrowserPrompt(
  socket: WebSocket,
  agentId: string,
  sessionId: string,
  prompt: string,
): ActiveBrowserPrompt {
  const commandId = crypto.randomUUID();
  const result = new Promise<BrowserPromptResult>((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("The browser prompt timed out"));
    }, 8_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.removeEventListener("message", handleMessage);
    };
    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (typeof event.data !== "string") {
        return;
      }
      const kind = decodeMessageKind(event.data);
      if (kind === AGENT_MESSAGE_DELTA_KIND) {
        const delta = decodeAgentMessageDeltaEvent(event.data);
        if (delta.commandId === commandId) {
          text += delta.text;
        }
        return;
      }
      if (kind === SESSION_COMPLETED_KIND) {
        const completed = decodeSessionCompletedEvent(event.data);
        if (completed.commandId === commandId) {
          cleanup();
          resolve(new BrowserPromptResult(text, completed.stopReason));
        }
        return;
      }
      if (kind === SESSION_FAILED_KIND) {
        const failed = decodeSessionFailedEvent(event.data);
        if (failed.commandId === commandId) {
          cleanup();
          reject(new Error(`${failed.code}: ${failed.message}`));
        }
      }
    };
    socket.addEventListener("message", handleMessage);
    socket.send(
      encodeSessionPromptCommand({
        additionalDirectoryIds: [],
        agentId,
        bindingId: "workspace",
        commandId,
        directoryId: "root",
        images: [],
        kind: SESSION_PROMPT_KIND,
        prompt,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        resources: [],
        sessionId,
      }),
    );
  });
  return new ActiveBrowserPrompt(commandId, result);
}

async function runBrowserPrompt(
  socket: WebSocket,
  agentId: string,
  sessionId: string,
  prompt: string,
): Promise<string> {
  return (await startBrowserPrompt(socket, agentId, sessionId, prompt).result)
    .text;
}

async function verifyActiveTurnHistory(
  daemonUrl: URL,
  origin: string,
  channelId: string,
): Promise<void> {
  const controlledDaemon = new WebSocket(daemonUrl);
  await waitForSocketOpen(controlledDaemon);
  const controlledHostUrl = new URL(
    `/v1/channels/${encodeURIComponent(channelId)}/host`,
    origin,
  );
  controlledHostUrl.protocol = "ws:";
  const controlledHost = new WebSocket(controlledHostUrl);
  const observingHost = new WebSocket(controlledHostUrl);
  try {
    await Promise.all([
      waitForRuntimeOnline(controlledHost),
      waitForRuntimeOnline(observingHost),
    ]);
    const controlledCommandId = crypto.randomUUID();
    const controlledSessionId = crypto.randomUUID();
    const forwardedPrompt = waitForProtocolKind(
      controlledDaemon,
      SESSION_PROMPT_KIND,
    );
    const observedPrompt = waitForProtocolKind(
      observingHost,
      SESSION_PROMPT_KIND,
    );
    controlledHost.send(
      encodeSessionPromptCommand({
        additionalDirectoryIds: [],
        agentId: "codex",
        bindingId: "workspace",
        commandId: controlledCommandId,
        directoryId: "root",
        images: [],
        kind: SESSION_PROMPT_KIND,
        prompt: "controlled task",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        resources: [],
        sessionId: controlledSessionId,
      }),
    );
    expect(decodeSessionPromptCommand(await forwardedPrompt).commandId).toBe(
      controlledCommandId,
    );
    expect(decodeSessionPromptCommand(await observedPrompt).commandId).toBe(
      controlledCommandId,
    );

    const pendingHistoryResponse = await fetch(
      new URL(`/v1/channels/${encodeURIComponent(channelId)}/history`, origin),
    );
    expect(pendingHistoryResponse.status).toBe(200);
    await expect(pendingHistoryResponse.json()).resolves.toEqual(
      expect.objectContaining({
        turns: expect.arrayContaining([
          expect.objectContaining({
            commandId: controlledCommandId,
            response: "",
            status: "pending",
          }),
        ]),
      }),
    );

    const forwardedStart = waitForProtocolKind(
      observingHost,
      SESSION_STARTED_KIND,
    );
    controlledDaemon.send(
      encodeSessionStartedEvent({
        commandId: controlledCommandId,
        kind: SESSION_STARTED_KIND,
        processAttemptId: "controlled-attempt",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: controlledSessionId,
      }),
    );
    expect(decodeSessionStartedEvent(await forwardedStart).commandId).toBe(
      controlledCommandId,
    );

    const forwardedDelta = waitForProtocolKind(
      observingHost,
      AGENT_MESSAGE_DELTA_KIND,
    );
    controlledDaemon.send(
      encodeAgentMessageDeltaEvent({
        commandId: controlledCommandId,
        kind: AGENT_MESSAGE_DELTA_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: controlledSessionId,
        text: "partial response",
      }),
    );
    expect(decodeAgentMessageDeltaEvent(await forwardedDelta).commandId).toBe(
      controlledCommandId,
    );

    const forwardedActivity = waitForProtocolKind(
      observingHost,
      AGENT_ACTIVITY_KIND,
    );
    controlledDaemon.send(
      encodeAgentActivityEvent({
        activityId: "controlled-tool",
        activityType: "tool",
        commandId: controlledCommandId,
        content: [],
        input: '{"path":"package.json"}',
        kind: AGENT_ACTIVITY_KIND,
        locations: [`${repositoryRoot}/package.json`],
        name: "read_file",
        output: "package metadata",
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sequence: 0,
        sessionId: controlledSessionId,
        status: "completed",
        title: "Read package metadata",
        toolKind: "read",
      }),
    );
    expect(decodeAgentActivityEvent(await forwardedActivity).commandId).toBe(
      controlledCommandId,
    );

    const runningHistoryResponse = await fetch(
      new URL(`/v1/channels/${encodeURIComponent(channelId)}/history`, origin),
    );
    expect(runningHistoryResponse.status).toBe(200);
    await expect(runningHistoryResponse.json()).resolves.toEqual(
      expect.objectContaining({
        turns: expect.arrayContaining([
          expect.objectContaining({
            commandId: controlledCommandId,
            processAttemptId: "controlled-attempt",
            response: "partial response",
            status: "running",
            activities: expect.arrayContaining([
              expect.objectContaining({
                activityId: "controlled-tool",
                output: "package metadata",
                status: "completed",
              }),
            ]),
          }),
        ]),
      }),
    );

    const forwardedCompletion = waitForProtocolKind(
      observingHost,
      SESSION_COMPLETED_KIND,
    );
    controlledDaemon.send(
      encodeSessionCompletedEvent({
        commandId: controlledCommandId,
        kind: SESSION_COMPLETED_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
        sessionId: controlledSessionId,
        stopReason: "end_turn",
      }),
    );
    expect(
      decodeSessionCompletedEvent(await forwardedCompletion).commandId,
    ).toBe(controlledCommandId);
  } finally {
    controlledHost.close(1000, "Controlled host E2E complete");
    observingHost.close(1000, "Observing host E2E complete");
    controlledDaemon.close(1000, "Controlled daemon E2E complete");
  }
}

describe("pairing and channel chat", () => {
  it("Given paired ACP agents, When browsers run conversations, Then responses and activities persist", {
    timeout: 30_000,
  }, async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-pairing-e2e-"),
    );
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port.toString()}`;
    const previousAgentPath = process.env["MOBIUS_ACP_AGENT_PATH"];
    const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
    process.env["MOBIUS_ACP_AGENT_PATH"] = fakeAgentPath;
    process.env["MOBIUS_STATE_DIRECTORY"] = temporaryDirectory;

    const wrangler = spawn(
      pnpmCommand,
      [
        "wrangler",
        "dev",
        "--ip",
        "127.0.0.1",
        "--port",
        port.toString(),
        "--persist-to",
        join(temporaryDirectory, "wrangler-state"),
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitForRelay(wrangler);
      const healthResponse = await fetch(new URL("/health", origin));
      expect(healthResponse.status).toBe(200);
      await expect(healthResponse.json()).resolves.toEqual({
        protocolVersion: 1,
        service: "mobius-relay",
        status: "ok",
      });
      const pairingResponse = await fetch(new URL("/v1/pairings", origin), {
        method: "POST",
      });
      expect(pairingResponse.status).toBe(201);
      const pairingBody: unknown = await pairingResponse.json();
      expect(pairingBody).not.toHaveProperty("hostToken");
      const pairing = decodeBrowserPairing(pairingBody);
      const paired = await pairLocalMachine([
        "--url",
        origin,
        "--code",
        pairing.pairingCode,
        "--root",
        repositoryRoot,
      ]);
      const resumed = await resumeLocalMachine([
        "--channel",
        pairing.channelId,
      ]);
      expect(resumed.channelUrl).toBe(paired.channelUrl);
      expect(resumed.config.approvedRoot).toBe(paired.config.approvedRoot);
      const savedConnection = await readFile(paired.connectionPath, "utf8");
      await writeFile(
        paired.connectionPath,
        savedConnection.replace("\n}\n", ',\n  "unexpected": true\n}\n'),
        { mode: 0o600 },
      );
      await expect(
        resumeLocalMachine(["--channel", pairing.channelId]),
      ).rejects.toMatchObject({ code: "invalid_connection" });
      await writeFile(paired.connectionPath, savedConnection, { mode: 0o600 });
      const repeatedClaimResponse = await fetch(
        new URL("/v1/pairings/claim", origin),
        {
          body: JSON.stringify({
            agents: [
              { id: "codex", label: "Codex" },
              { id: "claude", label: "Claude Code" },
            ],
            machineName: "second-machine",
            pairingCode: pairing.pairingCode,
            workspaceName: "second-workspace",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(repeatedClaimResponse.status).toBe(400);
      const publicChannelResponse = await fetch(
        new URL(
          `/v1/channels/${encodeURIComponent(pairing.channelId)}`,
          origin,
        ),
      );
      expect(publicChannelResponse.status).toBe(200);
      await expect(publicChannelResponse.json()).resolves.toMatchObject({
        channelId: pairing.channelId,
        machineName: expect.any(String),
        workspaceName: expect.any(String),
      });
      const wrongRoleResponse = await fetch(
        new URL(
          `/v1/channels/${encodeURIComponent(pairing.channelId)}/daemon?token=invalid`,
          origin,
        ),
      );
      expect(wrongRoleResponse.status).toBe(401);

      const audit = new AuditStore(paired.config.auditDatabasePath);
      const daemonController = new AbortController();
      const daemonRun = runDaemon(
        paired.config,
        audit,
        daemonController.signal,
      );
      try {
        const hostUrl = new URL(
          `/v1/channels/${encodeURIComponent(pairing.channelId)}/host`,
          origin,
        );
        hostUrl.protocol = "ws:";
        const socket = new WebSocket(hostUrl);
        try {
          await waitForRuntimeOnline(socket);
          const codexSessionId = crypto.randomUUID();
          await expect(
            runBrowserPrompt(socket, "codex", codexSessionId, "first"),
          ).resolves.toBe("Codex turn 1: first");
          await expect(
            runBrowserPrompt(socket, "codex", codexSessionId, "second"),
          ).resolves.toBe("Codex turn 2: second");
          const cancellationSessionId = crypto.randomUUID();
          const startedCancellation = waitForProtocolKind(
            socket,
            SESSION_STARTED_KIND,
          );
          const cancellationActivity = waitForProtocolKind(
            socket,
            AGENT_ACTIVITY_KIND,
          );
          const cancellablePrompt = startBrowserPrompt(
            socket,
            "codex",
            cancellationSessionId,
            "wait until cancelled",
          );
          await startedCancellation;
          await cancellationActivity;
          const encodedCancellation = encodeSessionCancelCommand({
            commandId: cancellablePrompt.commandId,
            kind: SESSION_CANCEL_KIND,
            protocolVersion: MOBIUS_PROTOCOL_VERSION,
            sessionId: cancellationSessionId,
          });
          socket.send(encodedCancellation);
          expect(
            decodeSessionCancelCommand(encodedCancellation).commandId,
          ).toBe(cancellablePrompt.commandId);
          await expect(cancellablePrompt.result).resolves.toMatchObject({
            stopReason: "cancelled",
          });
          await expect(
            runBrowserPrompt(
              socket,
              "codex",
              cancellationSessionId,
              "continue",
            ),
          ).resolves.toBe("Codex turn 2: continue");
          const otherBrowserSocket = new WebSocket(hostUrl);
          try {
            await waitForRuntimeOnline(otherBrowserSocket);
            await expect(
              runBrowserPrompt(
                otherBrowserSocket,
                "claude",
                crypto.randomUUID(),
                "hello",
              ),
            ).resolves.toBe("Claude Code turn 1: hello");
          } finally {
            otherBrowserSocket.close(1000, "Second browser E2E complete");
          }
          const historyResponse = await fetch(
            new URL(
              `/v1/channels/${encodeURIComponent(pairing.channelId)}/history`,
              origin,
            ),
          );
          expect(historyResponse.status).toBe(200);
          await expect(historyResponse.json()).resolves.toEqual(
            expect.objectContaining({
              runtimeId: pairing.channelId,
              turns: expect.arrayContaining([
                expect.objectContaining({
                  agentId: "codex",
                  activities: expect.arrayContaining([
                    expect.objectContaining({
                      activityType: "reasoning",
                      output: "Inspecting the workspace",
                      status: "completed",
                    }),
                    expect.objectContaining({
                      activityType: "tool",
                      output: expect.stringContaining("mobius-workspace"),
                      status: "completed",
                    }),
                  ]),
                  prompt: "first",
                  response: "Codex turn 1: first",
                  sessionId: codexSessionId,
                  status: "completed",
                }),
                expect.objectContaining({
                  agentId: "codex",
                  prompt: "second",
                  response: "Codex turn 2: second",
                  sessionId: codexSessionId,
                  status: "completed",
                }),
                expect.objectContaining({
                  agentId: "claude",
                  prompt: "hello",
                  response: "Claude Code turn 1: hello",
                  status: "completed",
                }),
                expect.objectContaining({
                  agentId: "codex",
                  commandId: cancellablePrompt.commandId,
                  prompt: "wait until cancelled",
                  sessionId: cancellationSessionId,
                  status: "completed",
                  stopReason: "cancelled",
                }),
              ]),
            }),
          );
        } finally {
          socket.close(1000, "E2E complete");
        }
      } finally {
        daemonController.abort();
        await daemonRun;
        audit.close();
      }
      await verifyActiveTurnHistory(
        paired.config.relayUrl,
        origin,
        pairing.channelId,
      );
    } finally {
      await stopProcess(wrangler);
      if (previousAgentPath === undefined) {
        delete process.env["MOBIUS_ACP_AGENT_PATH"];
      } else {
        process.env["MOBIUS_ACP_AGENT_PATH"] = previousAgentPath;
      }
      if (previousStateDirectory === undefined) {
        delete process.env["MOBIUS_STATE_DIRECTORY"];
      } else {
        process.env["MOBIUS_STATE_DIRECTORY"] = previousStateDirectory;
      }
      await rm(temporaryDirectory, { recursive: true });
    }
  });
});
