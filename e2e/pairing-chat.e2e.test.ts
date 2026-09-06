import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AcpSessionManager } from "../packages/cli/src/acp/session-manager.ts";
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
  decodeRuntimeHeartbeatAckEvent,
  decodeRuntimeLivenessReadyEvent,
  decodeRuntimeStatusEvent,
  decodeSessionCancelCommand,
  decodeSessionCompletedEvent,
  decodeSessionFailedEvent,
  decodeSessionPromptCommand,
  decodeSessionStartedEvent,
  decodeSessionUsageUpdatedEvent,
  encodeAgentActivityEvent,
  encodeAgentMessageDeltaEvent,
  encodeRuntimeHeartbeatEvent,
  encodeSessionCancelCommand,
  encodeSessionCompletedEvent,
  encodeSessionPrepareCommand,
  encodeSessionPromptCommand,
  encodeSessionStartedEvent,
  MOBIUS_PROTOCOL_VERSION,
  RUNTIME_HEARTBEAT_ACK_KIND,
  RUNTIME_HEARTBEAT_KIND,
  RUNTIME_LIVENESS_READY_KIND,
  RUNTIME_STATUS_KIND,
  SESSION_CANCEL_KIND,
  SESSION_COMPLETED_KIND,
  SESSION_FAILED_KIND,
  SESSION_PREPARE_KIND,
  SESSION_PROMPT_KIND,
  SESSION_READY_KIND,
  SESSION_STARTED_KIND,
  SESSION_USAGE_UPDATED_KIND,
  type SessionUsageUpdatedEvent,
} from "../packages/protocol/src/index.ts";
import { renderNativeHistory } from "../packages/web/tests/native-history-render.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fakeAgentPath = fileURLToPath(
  new URL("./fixtures/fake-acp-agent/src/cli.ts", import.meta.url),
);
const fakeAppServerUrl = new URL(
  "./fixtures/fake-acp-agent/src/app-server.ts",
  import.meta.url,
).toString();
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function executableSource(source: string): string {
  return `#!${process.execPath}\n${source}`;
}

function agentExecutableSource(label: string, version: string): string {
  return executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
} else if (process.argv.includes("app-server")) {
  await import(${JSON.stringify(fakeAppServerUrl)});
} else {
  if (${JSON.stringify(label)} === "Claude Code" && process.env.MOBIUS_FAKE_ACP_STATE_DIRECTORY !== undefined) {
    process.env.MOBIUS_FAKE_ACP_STATE_DIRECTORY += "/claude";
  }
  process.argv.push("--agent-name", ${JSON.stringify(label)});
  if (${JSON.stringify(label)} === "Codex") process.argv.push("--exclusive-writer");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`);
}

function adapterExecutableSource(
  environmentVariable: string,
  version: string,
): string {
  return executableSource(`
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
} else {
  const executable = process.env[${JSON.stringify(environmentVariable)}];
  if (executable === undefined) process.exit(91);
  const child = spawn(executable, [], { env: process.env, stdio: "inherit" });
  child.once("error", () => process.exit(92));
  child.once("exit", (code) => process.exit(code ?? 93));
}
`);
}

function packageManagerExecutableSource(recordPath: string): string {
  const packageName = "@agentclientprotocol/claude-agent-acp";
  const packageVersion = "0.73.0";
  const executableName = "claude-agent-acp";
  const adapterSource = adapterExecutableSource(
    "CLAUDE_CODE_EXECUTABLE",
    `claude-agent-acp ${packageVersion}`,
  );
  return executableSource(`
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const prefixIndex = process.argv.indexOf("--prefix");
const prefix = process.argv[prefixIndex + 1];
const packageRequest = process.argv.at(-1);
if (prefixIndex < 0 || prefix === undefined || packageRequest !== ${JSON.stringify(
    `${packageName}@${packageVersion}`,
  )}) {
  process.exit(64);
}
const packageRoot = join(prefix, "node_modules", "@agentclientprotocol", "claude-agent-acp");
const executablePath = join(packageRoot, "dist", "index.js");
await mkdir(join(packageRoot, "dist"), { mode: 0o700, recursive: true });
await writeFile(
  join(packageRoot, "package.json"),
  JSON.stringify({
    bin: { ${JSON.stringify(executableName)}: "dist/index.js" },
    name: ${JSON.stringify(packageName)},
    version: ${JSON.stringify(packageVersion)},
  }),
  { mode: 0o600 },
);
await writeFile(executablePath, ${JSON.stringify(adapterSource)}, { mode: 0o700 });
await chmod(executablePath, 0o700);
await appendFile(${JSON.stringify(recordPath)}, packageRequest + "\\n");
`);
}

function restoreEnvironmentVariable(
  name: string,
  previous: string | undefined,
): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

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
  readonly usage: readonly SessionUsageUpdatedEvent[];

  constructor(
    text: string,
    stopReason: string,
    usage: readonly SessionUsageUpdatedEvent[],
  ) {
    this.text = text;
    this.stopReason = stopReason;
    this.usage = usage;
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
    }, 20_000);
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
  directoryId = "default",
): ActiveBrowserPrompt {
  const commandId = crypto.randomUUID();
  const result = new Promise<BrowserPromptResult>((resolve, reject) => {
    let text = "";
    const usage: SessionUsageUpdatedEvent[] = [];
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
      if (kind === SESSION_USAGE_UPDATED_KIND) {
        const update = decodeSessionUsageUpdatedEvent(event.data);
        if (update.sessionId === sessionId) usage.push(update);
        return;
      }
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
          resolve(new BrowserPromptResult(text, completed.stopReason, usage));
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
        directoryId,
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
  directoryId = "default",
): Promise<string> {
  return (
    await startBrowserPrompt(socket, agentId, sessionId, prompt, directoryId)
      .result
  ).text;
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
        directoryId: "default",
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
  it("Given a machine is paired and has an Agent conversation in another project with a selected image, When a browser chooses a directory and opens that conversation, Then new chats use the chosen directory and restored history retains its original project through fork refresh and deletion", {
    timeout: 45_000,
  }, async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-native-e2e-"),
    );
    const workspace = join(temporaryDirectory, "workspace");
    await mkdir(workspace);
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port.toString()}`;
    const environment = {
      MOBIUS_CODEX_PATH: join(temporaryDirectory, "codex"),
      MOBIUS_CODEX_ACP_PATH: join(temporaryDirectory, "codex-acp"),
      MOBIUS_CLAUDE_PATH: join(temporaryDirectory, "claude"),
      MOBIUS_CLAUDE_ACP_PATH: join(temporaryDirectory, "claude-acp"),
      MOBIUS_STATE_DIRECTORY: join(temporaryDirectory, "mobius"),
      MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(temporaryDirectory, "native"),
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    const previous = Object.keys(environment).map(
      (key) =>
        [key, process.env[key]] satisfies readonly [string, string | undefined],
    );
    Object.assign(process.env, environment);
    await writeFile(
      environment.MOBIUS_CODEX_PATH,
      agentExecutableSource("Codex", "codex 0.153.0"),
      { mode: 0o700 },
    );
    await writeFile(
      environment.MOBIUS_CODEX_ACP_PATH,
      adapterExecutableSource("CODEX_PATH", "codex-acp 1.8.0"),
      { mode: 0o700 },
    );
    await writeFile(
      environment.MOBIUS_CLAUDE_PATH,
      agentExecutableSource("Claude Code", "claude 2.1.0"),
      { mode: 0o700 },
    );
    await writeFile(
      environment.MOBIUS_CLAUDE_ACP_PATH,
      adapterExecutableSource(
        "CLAUDE_CODE_EXECUTABLE",
        "claude-agent-acp 0.73.0",
      ),
      { mode: 0o700 },
    );
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
        join(temporaryDirectory, "relay"),
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const external = new AcpSessionManager();
    try {
      await waitForRelay(wrangler);
      const pairing = decodeBrowserPairing(
        await (
          await fetch(new URL("/v1/pairings", origin), { method: "POST" })
        ).json(),
      );
      const paired = await pairLocalMachine([
        "--url",
        origin,
        "--code",
        pairing.pairingCode,
      ]);
      expect(paired.config).toMatchObject({
        defaultWorkspace: await realpath(
          join(environment.MOBIUS_STATE_DIRECTORY, "workspace"),
        ),
      });
      const selectedImage = {
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        mimeType: "image/png",
        name: "selected.png",
      };
      const expectSelectedImage = (history: unknown): void => {
        const html = renderNativeHistory(history);
        expect(html).toContain(`<img`);
        expect(html).toContain(
          `src="data:image/png;base64,${selectedImage.data}"`,
        );
        expect(html).not.toContain("[@image]");
      };
      await external.runPrompt({
        additionalDirectories: [],
        agent: paired.config.catalog.find("codex"),
        commandId: "external-turn",
        cwd: workspace,
        images: [selectedImage],
        resources: [],
        prompt: "Saved native conversation",
        onActivity: async () => {},
        onText: async () => {},
        sessionId: "external-only",
        signal: new AbortController().signal,
      });
      await external.runPrompt({
        additionalDirectories: [],
        agent: paired.config.catalog.find("claude"),
        commandId: "claude-external-turn",
        cwd: workspace,
        images: [],
        resources: [],
        prompt: "Claude saved conversation",
        onActivity: async () => {},
        onText: async () => {},
        sessionId: "claude-external",
        signal: new AbortController().signal,
      });
      const audit = new AuditStore(paired.config.auditDatabasePath);
      const controller = new AbortController();
      const daemon = runDaemon(paired.config, audit, controller.signal);
      const hostUrl = new URL(`/v1/channels/${pairing.channelId}/host`, origin);
      hostUrl.protocol = "ws:";
      const socket = new WebSocket(hostUrl);
      void daemon.catch(() => socket.close());
      try {
        await waitForRuntimeOnline(socket);
        const identity = {
          additionalDirectoryIds: [],
          agentId: "codex",
          bindingId: "workspace",
          directoryId: "default",
          sessionId: "browser-draft",
        };
        const prepared = waitForProtocolKind(socket, SESSION_READY_KIND);
        socket.send(
          encodeSessionPrepareCommand({
            ...identity,
            kind: SESSION_PREPARE_KIND,
            protocolVersion: 1,
            requestId: "prepare-native-browser",
          }),
        );
        await prepared;
        const homeListing = waitForProtocolKind(socket, "workspace.entries");
        socket.send(
          JSON.stringify({
            kind: "workspace.list",
            protocolVersion: 1,
            bindingId: "workspace",
            directoryId: "home",
            requestId: "browse-home",
          }),
        );
        expect(JSON.parse(await homeListing)).toMatchObject({
          directoryLabel: "~",
        });
        const request = async (
          fields: Readonly<Record<string, unknown>>,
          requestId = crypto.randomUUID(),
        ): Promise<Readonly<Record<string, unknown>>> => {
          const result = new Promise<Readonly<Record<string, unknown>>>(
            (resolve, reject) => {
              const cleanup = (): void => {
                socket.removeEventListener("message", onMessage);
                socket.removeEventListener("close", onClose);
              };
              const onClose = (): void => {
                cleanup();
                reject(
                  new Error("The product rejected native session management"),
                );
              };
              const onMessage = (event: MessageEvent<unknown>): void => {
                if (typeof event.data !== "string") return;
                const value: unknown = JSON.parse(event.data);
                if (!isRecord(value) || value["requestId"] !== requestId)
                  return;
                if (
                  value["kind"] === "native.session.result" ||
                  value["kind"] === "session.operation.failed"
                ) {
                  cleanup();
                  resolve(value);
                }
              };
              socket.addEventListener("message", onMessage);
              socket.addEventListener("close", onClose);
            },
          );
          socket.send(
            JSON.stringify({
              ...identity,
              ...fields,
              kind: "native.session.request",
              protocolVersion: 1,
              requestId,
            }),
          );
          return await result;
        };
        const listing = await request({ action: "list", cursor: null });
        expect(listing).toMatchObject({
          action: "list",
          entries: [
            expect.objectContaining({ title: "Saved native conversation" }),
          ],
        });
        const entries = listing["entries"];
        if (
          !Array.isArray(entries) ||
          !isRecord(entries[0]) ||
          typeof entries[0]["entryId"] !== "string" ||
          typeof entries[0]["directoryId"] !== "string"
        )
          throw new Error("Expected a listed native session");
        const projectDirectoryId = entries[0]["directoryId"];
        const projectListing = waitForProtocolKind(socket, "workspace.entries");
        socket.send(
          JSON.stringify({
            kind: "workspace.list",
            protocolVersion: 1,
            bindingId: "workspace",
            directoryId: projectDirectoryId,
            requestId: "browse-other-project",
          }),
        );
        expect(JSON.parse(await projectListing)).toMatchObject({
          directoryId: projectDirectoryId,
          directoryLabel: expect.stringContaining("workspace"),
        });
        const chosen = waitForProtocolKind(socket, SESSION_READY_KIND);
        socket.send(
          encodeSessionPrepareCommand({
            ...identity,
            sessionId: "chosen-directory-chat",
            directoryId: projectDirectoryId,
            requestId: "choose-directory",
            kind: SESSION_PREPARE_KIND,
            protocolVersion: 1,
          }),
        );
        expect(JSON.parse(await chosen)).toMatchObject({
          directoryId: projectDirectoryId,
        });
        expect(
          await runBrowserPrompt(
            socket,
            "codex",
            "chosen-directory-chat",
            "Report working directory",
            projectDirectoryId,
          ),
        ).toBe(await realpath(workspace));
        const preview = await request({
          action: "import",
          entryId: entries[0]["entryId"],
          targetSessionId: "read-only-preview",
        });
        expect(preview).toMatchObject({
          action: "preview",
          entryId: entries[0]["entryId"],
          reason: "continuation_unavailable",
          history: {
            status: "available",
            messages: [
              { role: "user", text: "Saved native conversation" },
              {
                role: "assistant",
                text: "Codex turn 1: Saved native conversation",
              },
            ],
            truncated: false,
          },
        });
        expect(preview).not.toHaveProperty("ready");
        expectSelectedImage(preview["history"]);
        const previewHistory = await fetch(
          new URL(`/v1/channels/${pairing.channelId}/history`, origin),
        );
        expect(JSON.stringify(await previewHistory.json())).not.toContain(
          "read-only-preview",
        );
        await external.close();
        await writeFile(
          join(environment.MOBIUS_FAKE_ACP_STATE_DIRECTORY, "pause-load"),
          "",
        );
        const loading = waitForProtocolKind(socket, "session.info.updated");
        const cancellationId = crypto.randomUUID();
        const cancelledLoad = request(
          {
            action: "import",
            entryId: entries[0]["entryId"],
            targetSessionId: "cancelled-load",
          },
          cancellationId,
        );
        await loading;
        const claudeListing = await request({
          agentId: "claude",
          sessionId: "claude-browser",
          action: "list",
          cursor: null,
        });
        await rm(
          join(environment.MOBIUS_FAKE_ACP_STATE_DIRECTORY, "pause-load"),
        );
        socket.send(
          JSON.stringify({
            kind: "native.session.cancel",
            protocolVersion: 1,
            requestId: cancellationId,
            sessionId: identity.sessionId,
          }),
        );
        const nextImport = request({
          action: "import",
          entryId: entries[0]["entryId"],
          targetSessionId: "imported-chat",
        });
        expect(await cancelledLoad).toMatchObject({
          code: "native_session_cancelled",
        });

        expect(claudeListing).toMatchObject({
          action: "list",
          entries: [{ title: "Claude saved conversation" }],
        });
        const imported = await nextImport;
        expectSelectedImage(imported["history"]);
        expect(imported).toMatchObject({
          action: "import",
          ready: {
            sessionId: "imported-chat",
            restored: true,
            directoryId: projectDirectoryId,
          },
          history: {
            status: "available",
            messages: [
              { role: "user", text: "Saved native conversation" },
              {
                role: "assistant",
                text: "Codex turn 1: Saved native conversation",
              },
            ],
            truncated: false,
          },
        });
        await expect(
          runBrowserPrompt(
            socket,
            "codex",
            "imported-chat",
            "Continue native context",
            projectDirectoryId,
          ),
        ).resolves.toBe("Codex turn 2: Continue native context");
        const history = await fetch(
          new URL(`/v1/channels/${pairing.channelId}/history`, origin),
        );
        const persisted = await history.json();
        expect(persisted).toMatchObject({
          sessions: expect.arrayContaining([
            expect.objectContaining({
              sessionId: "imported-chat",
              restored: true,
              title: "Saved native conversation",
              nativeHistory: imported["history"],
            }),
          ]),
        });
        if (!isRecord(persisted) || !Array.isArray(persisted["sessions"]))
          throw new Error("Expected persisted conversations");
        const saved = persisted["sessions"].find(
          (session: unknown) =>
            isRecord(session) && session["sessionId"] === "imported-chat",
        );
        if (!isRecord(saved)) throw new Error("Expected imported history");
        expectSelectedImage(saved["nativeHistory"]);
        const forked = await request({
          action: "fork",
          entryId: entries[0]["entryId"],
          targetSessionId: "forked-chat",
        });
        expect(forked).toMatchObject({
          action: "fork",
          ready: { sessionId: "forked-chat", directoryId: projectDirectoryId },
          history: {
            status: "available",
            messages: [
              { role: "user", text: "Saved native conversation" },
              {
                role: "assistant",
                text: "Codex turn 1: Saved native conversation",
              },
              { role: "user", text: "Continue native context" },
              {
                role: "assistant",
                text: "Codex turn 2: Continue native context",
              },
            ],
          },
        });
        await expect(
          runBrowserPrompt(
            socket,
            "codex",
            "forked-chat",
            "Continue fork",
            projectDirectoryId,
          ),
        ).resolves.toBe("Codex turn 3: Continue fork");
        await expect(
          runBrowserPrompt(
            socket,
            "codex",
            "imported-chat",
            "Continue original",
            projectDirectoryId,
          ),
        ).resolves.toBe("Codex turn 3: Continue original");
        const reopened = await request({
          action: "import",
          entryId: entries[0]["entryId"],
          targetSessionId: "duplicate-import",
        });
        expect(reopened).toMatchObject({
          ready: { sessionId: "imported-chat" },
          history: {
            messages: expect.arrayContaining([
              { role: "assistant", text: "Codex turn 3: Continue original" },
            ]),
          },
        });
        const reopenedHistory = reopened["history"];
        if (!isRecord(reopenedHistory))
          throw new Error("Expected loaded history");
        expect(reopenedHistory["coveredCommandIds"]).toHaveLength(2);
        expect(
          await request({ action: "delete", entryId: entries[0]["entryId"] }),
        ).toMatchObject({
          action: "delete",
          deletedSessionIds: ["imported-chat"],
        });
        const deletedHistory = await fetch(
          new URL(`/v1/channels/${pairing.channelId}/history`, origin),
        );
        await expect(deletedHistory.json()).resolves.toMatchObject({
          sessions: expect.arrayContaining([
            expect.objectContaining({
              sessionId: "imported-chat",
              status: "deleted",
              nativeHistory: reopenedHistory,
            }),
          ]),
        });
        await expect(
          runBrowserPrompt(
            socket,
            "codex",
            "imported-chat",
            "Do not create another session",
            projectDirectoryId,
          ),
        ).rejects.toThrow("deleted");
        expect(
          await request({
            action: "import",
            entryId: entries[0]["entryId"],
            targetSessionId: "stale-import",
          }),
        ).toMatchObject({ code: "native_session_not_found" });
      } finally {
        socket.close();
        controller.abort();
        await daemon;
        audit.close();
      }
    } finally {
      await external.close();
      await stopProcess(wrangler);
      for (const [key, value] of previous)
        restoreEnvironmentVariable(key, value);
      vi.useRealTimers();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("Given a liveness-capable daemon, When it checks the relay connection, Then the relay acknowledges the exact heartbeat", {
    timeout: 30_000,
  }, async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-liveness-e2e-"),
    );
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port.toString()}`;
    const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
    const previousNoProxy = process.env["NO_PROXY"];
    const previousLowerNoProxy = process.env["no_proxy"];
    process.env["MOBIUS_STATE_DIRECTORY"] = temporaryDirectory;
    process.env["NO_PROXY"] = "127.0.0.1,localhost";
    process.env["no_proxy"] = "127.0.0.1,localhost";
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
    let daemon: WebSocket | undefined;

    try {
      await waitForRelay(wrangler);
      const pairingResponse = await fetch(new URL("/v1/pairings", origin), {
        method: "POST",
      });
      const pairing = decodeBrowserPairing(await pairingResponse.json());
      const paired = await pairLocalMachine([
        "--url",
        origin,
        "--code",
        pairing.pairingCode,
        "--workspace",
        repositoryRoot,
      ]);
      const daemonUrl = new URL(paired.config.relayUrl);
      daemonUrl.searchParams.set("liveness", "1");
      daemon = new WebSocket(daemonUrl);
      const ready = waitForProtocolKind(daemon, RUNTIME_LIVENESS_READY_KIND);
      await waitForSocketOpen(daemon);
      expect(decodeRuntimeLivenessReadyEvent(await ready)).toEqual({
        kind: RUNTIME_LIVENESS_READY_KIND,
        protocolVersion: MOBIUS_PROTOCOL_VERSION,
      });

      const heartbeatId = crypto.randomUUID();
      const acknowledgement = waitForProtocolKind(
        daemon,
        RUNTIME_HEARTBEAT_ACK_KIND,
      );
      daemon.send(
        encodeRuntimeHeartbeatEvent({
          heartbeatId,
          kind: RUNTIME_HEARTBEAT_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
        }),
      );

      expect(
        decodeRuntimeHeartbeatAckEvent(await acknowledgement).heartbeatId,
      ).toBe(heartbeatId);
    } finally {
      daemon?.close(1000, "Liveness E2E complete");
      await stopProcess(wrangler);
      if (previousStateDirectory === undefined) {
        delete process.env["MOBIUS_STATE_DIRECTORY"];
      } else {
        process.env["MOBIUS_STATE_DIRECTORY"] = previousStateDirectory;
      }
      restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
      restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
      await rm(temporaryDirectory, { recursive: true });
    }
  });

  it("Given a turn awaiting daemon acknowledgement, When a replacement daemon connects, Then the stalled conversation fails and accepts another message", {
    timeout: 30_000,
  }, async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-recovery-e2e-"),
    );
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port.toString()}`;
    const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
    const previousNoProxy = process.env["NO_PROXY"];
    const previousLowerNoProxy = process.env["no_proxy"];
    process.env["MOBIUS_STATE_DIRECTORY"] = temporaryDirectory;
    process.env["NO_PROXY"] = "127.0.0.1,localhost";
    process.env["no_proxy"] = "127.0.0.1,localhost";
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
    let host: WebSocket | undefined;
    let replacementDaemon: WebSocket | undefined;
    let staleDaemon: WebSocket | undefined;

    try {
      await waitForRelay(wrangler);
      const pairingResponse = await fetch(new URL("/v1/pairings", origin), {
        method: "POST",
      });
      const pairing = decodeBrowserPairing(await pairingResponse.json());
      const paired = await pairLocalMachine([
        "--url",
        origin,
        "--code",
        pairing.pairingCode,
        "--workspace",
        repositoryRoot,
      ]);
      staleDaemon = new WebSocket(paired.config.relayUrl);
      await waitForSocketOpen(staleDaemon);
      const hostUrl = new URL(
        `/v1/channels/${encodeURIComponent(pairing.channelId)}/host`,
        origin,
      );
      hostUrl.protocol = "ws:";
      host = new WebSocket(hostUrl);
      await waitForRuntimeOnline(host);

      const stalledCommandId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const stalledPrompt = waitForProtocolKind(
        staleDaemon,
        SESSION_PROMPT_KIND,
      );
      host.send(
        encodeSessionPromptCommand({
          additionalDirectoryIds: [],
          agentId: "codex",
          bindingId: "workspace",
          commandId: stalledCommandId,
          directoryId: "default",
          images: [],
          kind: SESSION_PROMPT_KIND,
          prompt: "stalled task",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          resources: [],
          sessionId,
        }),
      );
      expect(decodeSessionPromptCommand(await stalledPrompt).commandId).toBe(
        stalledCommandId,
      );

      replacementDaemon = new WebSocket(paired.config.relayUrl);
      await waitForSocketOpen(replacementDaemon);

      const recoveredHistoryResponse = await fetch(
        new URL(
          `/v1/channels/${encodeURIComponent(pairing.channelId)}/history`,
          origin,
        ),
      );
      expect(recoveredHistoryResponse.status).toBe(200);
      await expect(recoveredHistoryResponse.json()).resolves.toEqual(
        expect.objectContaining({
          turns: expect.arrayContaining([
            expect.objectContaining({
              code: "daemon_reconnected",
              commandId: stalledCommandId,
              status: "failed",
            }),
          ]),
        }),
      );

      const nextCommandId = crypto.randomUUID();
      const nextPrompt = waitForProtocolKind(
        replacementDaemon,
        SESSION_PROMPT_KIND,
      );
      host.send(
        encodeSessionPromptCommand({
          additionalDirectoryIds: [],
          agentId: "codex",
          bindingId: "workspace",
          commandId: nextCommandId,
          directoryId: "default",
          images: [],
          kind: SESSION_PROMPT_KIND,
          prompt: "continue after recovery",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          resources: [],
          sessionId,
        }),
      );
      expect(decodeSessionPromptCommand(await nextPrompt).commandId).toBe(
        nextCommandId,
      );
      replacementDaemon.send(
        encodeSessionStartedEvent({
          commandId: nextCommandId,
          kind: SESSION_STARTED_KIND,
          processAttemptId: "replacement-attempt",
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId,
        }),
      );
      replacementDaemon.send(
        encodeSessionCompletedEvent({
          commandId: nextCommandId,
          kind: SESSION_COMPLETED_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
          sessionId,
          stopReason: "end_turn",
        }),
      );

      const completedHistoryResponse = await fetch(
        new URL(
          `/v1/channels/${encodeURIComponent(pairing.channelId)}/history`,
          origin,
        ),
      );
      await expect(completedHistoryResponse.json()).resolves.toEqual(
        expect.objectContaining({
          turns: expect.arrayContaining([
            expect.objectContaining({
              commandId: nextCommandId,
              status: "completed",
            }),
          ]),
        }),
      );
    } finally {
      host?.close(1000, "Recovery E2E complete");
      replacementDaemon?.close(1000, "Recovery E2E complete");
      staleDaemon?.close(1000, "Recovery E2E complete");
      await stopProcess(wrangler);
      if (previousStateDirectory === undefined) {
        delete process.env["MOBIUS_STATE_DIRECTORY"];
      } else {
        process.env["MOBIUS_STATE_DIRECTORY"] = previousStateDirectory;
      }
      restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
      restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
      await rm(temporaryDirectory, { recursive: true });
    }
  });

  it("Given supported Agents and a paired machine, When the connection resumes and a browser sends prompts, Then responses and usage persist", {
    timeout: 45_000,
  }, async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "mobius-pairing-e2e-"),
    );
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port.toString()}`;
    const executableDirectory = join(temporaryDirectory, "bin");
    const codexPath = join(executableDirectory, "codex");
    const codexAdapterPath = join(executableDirectory, "codex-acp");
    const claudePath = join(executableDirectory, "claude");
    const packageManagerPath = join(executableDirectory, "npm");
    const packageManagerRecordPath = join(
      temporaryDirectory,
      "adapter-package-requests.txt",
    );
    await mkdir(executableDirectory, { mode: 0o700 });
    await Promise.all([
      writeFile(codexPath, agentExecutableSource("Codex", "codex 0.153.0"), {
        mode: 0o700,
      }),
      writeFile(
        codexAdapterPath,
        adapterExecutableSource("CODEX_PATH", "codex-acp 1.8.0"),
        { mode: 0o700 },
      ),
      writeFile(
        claudePath,
        agentExecutableSource("Claude Code", "2.1.138 (Claude Code)"),
        { mode: 0o700 },
      ),
      writeFile(
        packageManagerPath,
        packageManagerExecutableSource(packageManagerRecordPath),
        { mode: 0o700 },
      ),
    ]);
    await Promise.all(
      [codexPath, codexAdapterPath, claudePath, packageManagerPath].map(
        async (path) => await chmod(path, 0o700),
      ),
    );
    const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
    const previousCodexAdapterPath = process.env["MOBIUS_CODEX_ACP_PATH"];
    const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
    const previousClaudeAdapterPath = process.env["MOBIUS_CLAUDE_ACP_PATH"];
    const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
    const previousPath = process.env["PATH"];
    const previousNoProxy = process.env["NO_PROXY"];
    const previousLowerNoProxy = process.env["no_proxy"];
    process.env["MOBIUS_CODEX_PATH"] = codexPath;
    process.env["MOBIUS_CODEX_ACP_PATH"] = codexAdapterPath;
    process.env["MOBIUS_CLAUDE_PATH"] = claudePath;
    delete process.env["MOBIUS_CLAUDE_ACP_PATH"];
    process.env["MOBIUS_STATE_DIRECTORY"] = temporaryDirectory;
    process.env["PATH"] =
      `${executableDirectory}${delimiter}${previousPath ?? ""}`;
    process.env["NO_PROXY"] = "127.0.0.1,localhost";
    process.env["no_proxy"] = "127.0.0.1,localhost";

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
        "--workspace",
        repositoryRoot,
      ]);
      const initiallyResumed = await resumeLocalMachine([
        "--channel",
        pairing.channelId,
      ]);
      expect(initiallyResumed.channelUrl).toBe(paired.channelUrl);
      expect(initiallyResumed.config.defaultWorkspace).toBe(
        paired.config.defaultWorkspace,
      );
      const savedConnection = await readFile(paired.connectionPath, "utf8");
      const resumed = await resumeLocalMachine([
        "--channel",
        pairing.channelId,
      ]);
      expect(resumed.config.defaultWorkspace).toBe(
        await realpath(repositoryRoot),
      );
      await writeFile(
        paired.connectionPath,
        savedConnection.replace("\n}\n", ',\n  "unexpected": true\n}\n'),
        { mode: 0o600 },
      );
      await expect(
        resumeLocalMachine(["--channel", pairing.channelId]),
      ).rejects.toMatchObject({ code: "invalid_connection" });
      await writeFile(paired.connectionPath, savedConnection, {
        mode: 0o600,
      });
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
      const publicChannel: unknown = await publicChannelResponse.json();
      expect(publicChannel).toMatchObject({
        agents: [{ id: "codex", label: "Codex" }],
        channelId: pairing.channelId,
        installableAgents: [
          {
            id: "claude",
            label: "Claude Code",
            requiresLocalApproval: true,
          },
        ],
        machineName: expect.any(String),
        workspaceName: expect.any(String),
      });
      expect(JSON.stringify(publicChannel)).not.toContain(temporaryDirectory);
      const catalogEndpoint = new URL(paired.config.relayUrl);
      catalogEndpoint.protocol = "http:";
      catalogEndpoint.pathname = catalogEndpoint.pathname.replace(
        /\/daemon$/,
        "/catalog",
      );
      catalogEndpoint.searchParams.set("token", "invalid");
      const unauthorizedCatalogUpdate = await fetch(catalogEndpoint, {
        body: JSON.stringify({
          agents: [{ id: "codex", label: "Codex" }],
          installableAgents: [],
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(unauthorizedCatalogUpdate.status).toBe(401);
      catalogEndpoint.search = paired.config.relayUrl.search;
      const injectedCatalogUpdate = await fetch(catalogEndpoint, {
        body: JSON.stringify({
          agents: [{ id: "codex", label: "Codex", path: codexPath }],
          installableAgents: [],
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      expect(injectedCatalogUpdate.status).toBe(400);
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
        resumed.config,
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
          const automaticallyProvisionedDescriptor = await fetch(
            new URL(
              `/v1/channels/${encodeURIComponent(pairing.channelId)}`,
              origin,
            ),
          );
          await expect(
            automaticallyProvisionedDescriptor.json(),
          ).resolves.toMatchObject({
            agents: [
              { id: "codex", label: "Codex" },
              { id: "claude", label: "Claude Code" },
            ],
            installableAgents: [],
          });
          await expect(
            readFile(packageManagerRecordPath, "utf8"),
          ).resolves.toBe("@agentclientprotocol/claude-agent-acp@0.73.0\n");
          await expect(
            runBrowserPrompt(
              socket,
              "unregistered-agent",
              crypto.randomUUID(),
              "must not affect executable lookup",
            ),
          ).rejects.toThrow("agent_not_ready");
          const codexSessionId = crypto.randomUUID();
          await expect(
            runBrowserPrompt(socket, "codex", codexSessionId, "first"),
          ).resolves.toBe("Codex turn 1: first");
          await expect(
            runBrowserPrompt(socket, "codex", codexSessionId, "second"),
          ).resolves.toBe("Codex turn 2: second");
          const usageSessions: string[] = [];
          for (const [agent, label, total] of [
            ["codex", "Codex", 1_000],
            ["claude", "Claude", 1_100],
          ] satisfies readonly (readonly [string, string, number])[]) {
            const usageSessionId = crypto.randomUUID();
            usageSessions.push(usageSessionId);
            const preparedUsageSession = waitForProtocolKind(
              socket,
              SESSION_READY_KIND,
            );
            socket.send(
              encodeSessionPrepareCommand({
                additionalDirectoryIds: [],
                agentId: agent,
                bindingId: "workspace",
                directoryId: "default",
                kind: SESSION_PREPARE_KIND,
                protocolVersion: MOBIUS_PROTOCOL_VERSION,
                requestId: crypto.randomUUID(),
                sessionId: usageSessionId,
              }),
            );
            await preparedUsageSession;
            for (const turn of [1, 2]) {
              const running = startBrowserPrompt(
                socket,
                agent,
                usageSessionId,
                `report ${label} usage`,
              );
              const result = await running.result;
              expect(result.usage).toMatchObject([
                {
                  source: "context",
                  size: 200_000,
                  used: 50_000,
                  costAmount: 0.125 * turn,
                },
                {
                  source: "prompt",
                  commandId: running.commandId,
                  usage: {
                    totalTokens: total * turn,
                    inputTokens: 600 * turn,
                    outputTokens: 200 * turn,
                  },
                  _meta: {
                    quota: {
                      token_count: { totalTokens: total * turn },
                      model_usage: [
                        expect.objectContaining({ model: expect.any(String) }),
                      ],
                    },
                  },
                },
              ]);
              expect(JSON.stringify(result.usage)).not.toContain("privateData");
            }
          }
          const usageHistory = await fetch(
            new URL(
              `/v1/channels/${encodeURIComponent(pairing.channelId)}/history`,
              origin,
            ),
          );
          await expect(usageHistory.json()).resolves.toMatchObject({
            sessions: expect.arrayContaining(
              usageSessions.map((sessionId, index) =>
                expect.objectContaining({
                  sessionId,
                  usage: [
                    expect.objectContaining({
                      source: "context",
                      used: 50_000,
                      costAmount: 0.25,
                    }),
                    expect.objectContaining({
                      source: "prompt",
                      usage: expect.objectContaining({
                        totalTokens: index === 0 ? 2_000 : 2_200,
                      }),
                    }),
                  ],
                }),
              ),
            ),
          });
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
      const refreshed = await resumeLocalMachine([
        "--channel",
        pairing.channelId,
      ]);
      const refreshedAudit = new AuditStore(refreshed.config.auditDatabasePath);
      const refreshedController = new AbortController();
      const refreshedDaemon = runDaemon(
        refreshed.config,
        refreshedAudit,
        refreshedController.signal,
      );
      const refreshedHostUrl = new URL(
        `/v1/channels/${encodeURIComponent(pairing.channelId)}/host`,
        origin,
      );
      refreshedHostUrl.protocol = "ws:";
      const refreshedHost = new WebSocket(refreshedHostUrl);
      try {
        await waitForRuntimeOnline(refreshedHost);
        const refreshedDescriptor = await fetch(
          new URL(
            `/v1/channels/${encodeURIComponent(pairing.channelId)}`,
            origin,
          ),
        );
        await expect(refreshedDescriptor.json()).resolves.toMatchObject({
          agents: [
            { id: "codex", label: "Codex" },
            { id: "claude", label: "Claude Code" },
          ],
          installableAgents: [],
        });
      } finally {
        refreshedHost.close(1000, "Refreshed catalog E2E complete");
        refreshedController.abort();
        await refreshedDaemon;
        refreshedAudit.close();
      }
      await verifyActiveTurnHistory(
        paired.config.relayUrl,
        origin,
        pairing.channelId,
      );
    } finally {
      await stopProcess(wrangler);
      restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
      restoreEnvironmentVariable(
        "MOBIUS_CODEX_ACP_PATH",
        previousCodexAdapterPath,
      );
      restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
      restoreEnvironmentVariable(
        "MOBIUS_CLAUDE_ACP_PATH",
        previousClaudeAdapterPath,
      );
      restoreEnvironmentVariable(
        "MOBIUS_STATE_DIRECTORY",
        previousStateDirectory,
      );
      restoreEnvironmentVariable("PATH", previousPath);
      restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
      restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
      await rm(temporaryDirectory, { recursive: true });
    }
  });
});
