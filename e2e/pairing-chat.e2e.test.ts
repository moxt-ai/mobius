import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AcpSessionManager } from "../packages/cli/src/acp/session-manager.ts";
import { AuditStore } from "../packages/cli/src/audit/audit-store.ts";
import { pairLocalMachine, resumeLocalMachine } from "../packages/cli/src/pairing/pair-local-machine.ts";
import { runDaemon } from "../packages/cli/src/run-daemon.ts";
import {
    AGENT_ACTIVITY_KIND,
    AGENT_INSTALL_COMPLETED_KIND,
    AGENT_INSTALL_FAILED_KIND,
    AGENT_INSTALL_REQUEST_KIND,
    AGENT_INSTALL_STARTED_KIND,
    AGENT_MESSAGE_DELTA_KIND,
    decodeAgentActivityEvent,
    decodeAgentInstallCompletedEvent,
    decodeAgentInstallFailedEvent,
    decodeAgentMessageDeltaEvent,
    decodeCommittedSessionEvent,
    decodeMessageKind,
    decodeRuntimeHeartbeatAckEvent,
    decodeRuntimeLivenessReadyEvent,
    decodeRuntimeStatusEvent,
    decodeSessionCancelCommand,
    decodeSessionCompletedEvent,
    decodeSessionElicitationRequestedEvent,
    decodeSessionFailedEvent,
    decodeSessionPermissionRequestedEvent,
    decodeSessionPromptCommand,
    decodeSessionStartedEvent,
    decodeSessionUsageUpdatedEvent,
    encodeAgentActivityEvent,
    encodeAgentInstallRequestCommand,
    encodeAgentMessageDeltaEvent,
    encodeRuntimeHeartbeatEvent,
    encodeSessionCancelCommand,
    encodeSessionCompletedEvent,
    encodeSessionElicitationRespondCommand,
    encodeSessionEventEnvelope,
    encodeSessionFailedEvent,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeSessionStartedEvent,
    MOBIUS_API_PREFIX,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_STATUS_KIND,
    SESSION_CANCEL_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_EVENT_COMMITTED_KIND,
    SESSION_EVENT_KIND,
    SESSION_FAILED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PREPARE_KIND,
    SESSION_PROMPT_KIND,
    SESSION_READY_KIND,
    SESSION_STARTED_KIND,
    SESSION_USAGE_UPDATED_KIND,
    type SessionUsageUpdatedEvent,
} from "../packages/protocol/src/index.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const fakeAgentPath = fileURLToPath(new URL("./fixtures/fake-acp-agent/src/cli.ts", import.meta.url));
const fakeAppServerUrl = new URL("./fixtures/fake-acp-agent/src/app-server.ts", import.meta.url).toString();
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const verifiedAgentCapabilities = {
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
};

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
  if (${JSON.stringify(label)} === "Codex") {
    process.argv.push("--exclusive-writer");
    process.argv.push("--oversized-native-session-title");
  }
  if (${JSON.stringify(label)} === "Claude Code") process.argv.push("--announce-commands-while-listing");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`);
}

function adapterExecutableSource(environmentVariable: string, version: string): string {
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
    const adapterSource = adapterExecutableSource("CLAUDE_CODE_EXECUTABLE", `claude-agent-acp ${packageVersion}`);
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

function restoreEnvironmentVariable(name: string, previous: string | undefined): void {
    if (previous === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = previous;
    }
}

class BrowserPairingCredentials {
    readonly channelId: string;
    readonly hostToken: string;
    readonly pairingCode: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly tenantId: string;

    constructor(
        channelId: string,
        pairingCode: string,
        hostToken: string,
        tenantId: string,
        projectId: string,
        runtimeId: string,
    ) {
        this.channelId = channelId;
        this.hostToken = hostToken;
        this.pairingCode = pairingCode;
        this.projectId = projectId;
        this.runtimeId = runtimeId;
        this.tenantId = tenantId;
    }
}

class BrowserPromptResult {
    readonly stopReason: string;
    readonly text: string;
    readonly usage: readonly SessionUsageUpdatedEvent[];

    constructor(text: string, stopReason: string, usage: readonly SessionUsageUpdatedEvent[]) {
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
    const hostToken = value["hostToken"];
    const pairingCode = value["pairingCode"];
    const projectId = value["projectId"];
    const runtimeId = value["runtimeId"];
    const tenantId = value["tenantId"];
    if (
        typeof channelId !== "string" ||
        typeof hostToken !== "string" ||
        typeof pairingCode !== "string" ||
        typeof projectId !== "string" ||
        typeof runtimeId !== "string" ||
        typeof tenantId !== "string"
    ) {
        throw new Error("Invalid pairing response");
    }
    return new BrowserPairingCredentials(channelId, pairingCode, hostToken, tenantId, projectId, runtimeId);
}

function authenticatedHeaders(pairing: BrowserPairingCredentials): Readonly<Record<string, string>> {
    return { authorization: `Bearer ${pairing.hostToken}` };
}

function hostSocketUrl(pairing: BrowserPairingCredentials, origin: string): URL {
    const url = new URL(`${MOBIUS_API_PREFIX}/channels/${encodeURIComponent(pairing.channelId)}/host`, origin);
    url.protocol = "ws:";
    url.searchParams.set("token", pairing.hostToken);
    return url;
}

function projectSessionUrl(pairing: BrowserPairingCredentials, origin: string, sessionId?: string, suffix = ""): URL {
    const base = `${MOBIUS_API_PREFIX}/projects/${encodeURIComponent(pairing.projectId)}/sessions`;
    const session = sessionId === undefined ? "" : `/${encodeURIComponent(sessionId)}`;
    return new URL(`${base}${session}${suffix}`, origin);
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

function waitForRuntimeReconnect(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        let observedOffline = false;
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("The daemon did not reconnect"));
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
            const status = decodeRuntimeStatusEvent(event.data);
            if (!status.online) {
                observedOffline = true;
                return;
            }
            if (observedOffline) {
                cleanup();
                resolve();
            }
        };
        socket.addEventListener("error", handleError);
        socket.addEventListener("message", handleMessage);
    });
}

function unwrapCommittedEvent(message: string): string {
    return decodeMessageKind(message) === SESSION_EVENT_COMMITTED_KIND
        ? decodeCommittedSessionEvent(message).payload
        : message;
}

const browserEventSources = new Map<string, { readonly attemptId: string; nextSourceSeq: number }>();

function sendSessionEvent(socket: WebSocket, sessionId: string, payload: string): void {
    const kind = decodeMessageKind(payload);
    const existing = browserEventSources.get(sessionId);
    const source =
        kind === SESSION_STARTED_KIND
            ? {
                  attemptId: decodeSessionStartedEvent(payload).attemptId,
                  nextSourceSeq: 1,
              }
            : existing;
    if (source === undefined) {
        throw new Error("An execution event has no Attempt source identity");
    }
    browserEventSources.set(sessionId, source);
    socket.send(
        encodeSessionEventEnvelope({
            eventId: crypto.randomUUID(),
            kind: SESSION_EVENT_KIND,
            payload,
            sessionId,
            source: {
                attemptId: source.attemptId,
                kind: "attempt",
                sourceSeq: source.nextSourceSeq.toString(),
            },
        }),
    );
    source.nextSourceSeq += 1;
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

function waitForProtocolKind(socket: WebSocket, expectedKind: string): Promise<string> {
    return waitForProtocolKinds(socket, [expectedKind]);
}

function waitForProtocolKinds(
    socket: WebSocket,
    expectedKinds: readonly string[],
    timeoutMilliseconds = 8_000,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`Did not receive ${expectedKinds.join(" or ")}`));
        }, timeoutMilliseconds);
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
            if (typeof event.data !== "string") {
                return;
            }
            const message = unwrapCommittedEvent(event.data);
            if (!expectedKinds.includes(decodeMessageKind(message))) {
                return;
            }
            cleanup();
            resolve(message);
        };
        socket.addEventListener("message", handleMessage);
        socket.addEventListener("error", handleError);
    });
}

function waitForSessionReady(socket: WebSocket, requestId: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const cleanup = (): void => {
            socket.removeEventListener("message", handleMessage);
            socket.removeEventListener("error", handleError);
            socket.removeEventListener("close", handleClose);
        };
        const handleError = (): void => {
            cleanup();
            reject(new Error("The WebSocket failed while preparing the session"));
        };
        const handleClose = (): void => {
            cleanup();
            reject(new Error("The WebSocket closed while preparing the session"));
        };
        const handleMessage = (event: MessageEvent<unknown>): void => {
            if (typeof event.data !== "string") {
                return;
            }
            const message = unwrapCommittedEvent(event.data);
            const value: unknown = JSON.parse(message);
            if (!isRecord(value) || value["requestId"] !== requestId) {
                return;
            }
            if (value["kind"] === SESSION_READY_KIND) {
                cleanup();
                resolve(message);
                return;
            }
            if (value["kind"] === "session.operation.failed") {
                cleanup();
                reject(new Error(`Session preparation failed: ${String(value["code"])}: ${String(value["message"])}`));
            }
        };
        socket.addEventListener("message", handleMessage);
        socket.addEventListener("error", handleError);
        socket.addEventListener("close", handleClose);
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
            const message = unwrapCommittedEvent(event.data);
            const kind = decodeMessageKind(message);
            if (kind === SESSION_USAGE_UPDATED_KIND) {
                const update = decodeSessionUsageUpdatedEvent(message);
                if (update.sessionId === sessionId) {
                    usage.push(update);
                }
                return;
            }
            if (kind === AGENT_MESSAGE_DELTA_KIND) {
                const delta = decodeAgentMessageDeltaEvent(message);
                if (delta.commandId === commandId) {
                    text += delta.text;
                }
                return;
            }
            if (kind === SESSION_COMPLETED_KIND) {
                const completed = decodeSessionCompletedEvent(message);
                if (completed.commandId === commandId) {
                    cleanup();
                    resolve(new BrowserPromptResult(text, completed.stopReason, usage));
                }
                return;
            }
            if (kind === SESSION_FAILED_KIND) {
                const failed = decodeSessionFailedEvent(message);
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
    return (await startBrowserPrompt(socket, agentId, sessionId, prompt, directoryId).result).text;
}

async function verifyActiveTurnHistory(
    daemonUrl: URL,
    origin: string,
    pairing: BrowserPairingCredentials,
): Promise<void> {
    const controlledDaemon = new WebSocket(daemonUrl);
    await waitForSocketOpen(controlledDaemon);
    const controlledHostUrl = hostSocketUrl(pairing, origin);
    const controlledHost = new WebSocket(controlledHostUrl);
    const observingHost = new WebSocket(controlledHostUrl);
    try {
        await Promise.all([waitForRuntimeOnline(controlledHost), waitForRuntimeOnline(observingHost)]);
        const controlledCommandId = crypto.randomUUID();
        const controlledSessionId = crypto.randomUUID();
        const forwardedPrompt = waitForProtocolKind(controlledDaemon, SESSION_PROMPT_KIND);
        const observedPrompt = waitForProtocolKind(observingHost, SESSION_PROMPT_KIND);
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
                resources: [],
                sessionId: controlledSessionId,
            }),
        );
        expect(decodeSessionPromptCommand(await forwardedPrompt).commandId).toBe(controlledCommandId);
        expect(decodeSessionPromptCommand(await observedPrompt).commandId).toBe(controlledCommandId);

        const pendingHistoryResponse = await fetch(
            projectSessionUrl(pairing, origin, controlledSessionId, "/messages"),
            { headers: authenticatedHeaders(pairing) },
        );
        expect(pendingHistoryResponse.status).toBe(200);
        await expect(pendingHistoryResponse.json()).resolves.toEqual(
            expect.objectContaining({
                messages: expect.arrayContaining([
                    expect.objectContaining({
                        attempt: null,
                        commandId: controlledCommandId,
                        response: "",
                    }),
                ]),
            }),
        );

        const forwardedStart = waitForProtocolKind(observingHost, SESSION_STARTED_KIND);
        sendSessionEvent(
            controlledDaemon,
            controlledSessionId,
            encodeSessionStartedEvent({
                commandId: controlledCommandId,
                kind: SESSION_STARTED_KIND,
                attemptId: "controlled-attempt",
                sessionId: controlledSessionId,
            }),
        );
        expect(decodeSessionStartedEvent(await forwardedStart).commandId).toBe(controlledCommandId);

        const forwardedDelta = waitForProtocolKind(observingHost, AGENT_MESSAGE_DELTA_KIND);
        sendSessionEvent(
            controlledDaemon,
            controlledSessionId,
            encodeAgentMessageDeltaEvent({
                commandId: controlledCommandId,
                kind: AGENT_MESSAGE_DELTA_KIND,
                sessionId: controlledSessionId,
                text: "partial response",
            }),
        );
        expect(decodeAgentMessageDeltaEvent(await forwardedDelta).commandId).toBe(controlledCommandId);

        const forwardedActivity = waitForProtocolKind(observingHost, AGENT_ACTIVITY_KIND);
        sendSessionEvent(
            controlledDaemon,
            controlledSessionId,
            encodeAgentActivityEvent({
                activityId: "controlled-tool",
                activityType: "tool",
                commandId: controlledCommandId,
                content: [],
                detail: { kind: "unrecorded" },
                input: '{"path":"package.json"}',
                kind: AGENT_ACTIVITY_KIND,
                locations: [`${repositoryRoot}/package.json`],
                name: "read_file",
                output: "package metadata",
                sequence: 0,
                sessionId: controlledSessionId,
                status: "completed",
                title: "Read package metadata",
                toolKind: "read",
            }),
        );
        expect(decodeAgentActivityEvent(await forwardedActivity).commandId).toBe(controlledCommandId);

        const runningHistoryResponse = await fetch(
            projectSessionUrl(pairing, origin, controlledSessionId, "/messages"),
            { headers: authenticatedHeaders(pairing) },
        );
        expect(runningHistoryResponse.status).toBe(200);
        await expect(runningHistoryResponse.json()).resolves.toEqual(
            expect.objectContaining({
                messages: expect.arrayContaining([
                    expect.objectContaining({
                        commandId: controlledCommandId,
                        response: "partial response",
                        attempt: expect.objectContaining({
                            kind: "running",
                            attemptId: "controlled-attempt",
                        }),
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

        const forwardedCompletion = waitForProtocolKind(observingHost, SESSION_COMPLETED_KIND);
        sendSessionEvent(
            controlledDaemon,
            controlledSessionId,
            encodeSessionCompletedEvent({
                commandId: controlledCommandId,
                kind: SESSION_COMPLETED_KIND,
                sessionId: controlledSessionId,
                stopReason: "end_turn",
            }),
        );
        expect(decodeSessionCompletedEvent(await forwardedCompletion).commandId).toBe(controlledCommandId);
        const completedHistoryResponse = await fetch(
            projectSessionUrl(pairing, origin, controlledSessionId, "/messages"),
            { headers: authenticatedHeaders(pairing) },
        );
        await expect(completedHistoryResponse.json()).resolves.toEqual(
            expect.objectContaining({
                messages: expect.arrayContaining([
                    expect.objectContaining({
                        attempt: expect.objectContaining({ kind: "succeeded" }),
                        commandId: controlledCommandId,
                    }),
                ]),
            }),
        );
    } finally {
        controlledHost.close(1000, "Controlled host E2E complete");
        observingHost.close(1000, "Observing host E2E complete");
        controlledDaemon.close(1000, "Controlled daemon E2E complete");
    }
}

describe("pairing and channel chat", () => {
    it("Given a machine is paired with saved Agent conversations and the first runtime handshake fails, When a browser prepares and manages those conversations, Then initialization recovers and restored history retains its original project through fork refresh and deletion", {
        timeout: 90_000,
    }, async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-native-e2e-"));
        const workspace = join(temporaryDirectory, "workspace");
        await mkdir(workspace);
        const port = await reservePort();
        const origin = `http://127.0.0.1:${port.toString()}`;
        const environment = {
            MOBIUS_GEMINI_PATH: join(temporaryDirectory, "missing-gemini"),
            MOBIUS_CODEX_PATH: join(temporaryDirectory, "codex"),
            MOBIUS_CODEX_ACP_PATH: join(temporaryDirectory, "codex-acp"),
            MOBIUS_CLAUDE_PATH: join(temporaryDirectory, "claude"),
            MOBIUS_CLAUDE_ACP_PATH: join(temporaryDirectory, "claude-acp"),
            MOBIUS_COPILOT_PATH: join(temporaryDirectory, "missing-copilot"),
            MOBIUS_HERMES_PATH: join(temporaryDirectory, "missing-hermes"),
            MOBIUS_STATE_DIRECTORY: join(temporaryDirectory, "mobius"),
            MOBIUS_FAKE_ACP_FAIL_RUNTIME_INITIALIZATION: "",
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(temporaryDirectory, "native"),
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
        };
        const previous = Object.keys(environment).map(
            (key) => [key, process.env[key]] satisfies readonly [string, string | undefined],
        );
        Object.assign(process.env, environment);
        await writeFile(environment.MOBIUS_CODEX_PATH, agentExecutableSource("Codex", "codex 0.153.0"), {
            mode: 0o700,
        });
        await writeFile(environment.MOBIUS_CODEX_ACP_PATH, adapterExecutableSource("CODEX_PATH", "codex-acp 1.8.0"), {
            mode: 0o700,
        });
        await writeFile(environment.MOBIUS_CLAUDE_PATH, agentExecutableSource("Claude Code", "claude 2.1.0"), {
            mode: 0o700,
        });
        await writeFile(
            environment.MOBIUS_CLAUDE_ACP_PATH,
            adapterExecutableSource("CLAUDE_CODE_EXECUTABLE", "claude-agent-acp 0.73.0"),
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
                    await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings`, origin), {
                        method: "POST",
                    })
                ).json(),
            );
            const paired = await pairLocalMachine(["--url", origin, "--code", pairing.pairingCode]);
            expect(paired.config).toMatchObject({
                defaultWorkspace: await realpath(join(environment.MOBIUS_STATE_DIRECTORY, "workspace")),
            });
            const selectedImage = {
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                mimeType: "image/png",
                name: "selected.png",
            };
            const expectSelectedImageHistory = (history: unknown): void => {
                expect(history).toMatchObject({
                    messages: expect.arrayContaining([
                        expect.objectContaining({
                            images: expect.arrayContaining([
                                expect.objectContaining({
                                    data: selectedImage.data,
                                    mimeType: selectedImage.mimeType,
                                }),
                            ]),
                        }),
                    ]),
                });
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
            process.env["MOBIUS_FAKE_ACP_FAIL_RUNTIME_INITIALIZATION"] = "Codex";
            const audit = new AuditStore(paired.config.auditDatabasePath);
            const controller = new AbortController();
            const daemon = runDaemon(paired.config, audit, controller.signal);
            const socket = new WebSocket(hostSocketUrl(pairing, origin));
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
                const prepared = waitForSessionReady(socket, "prepare-native-browser");
                socket.send(
                    encodeSessionPrepareCommand({
                        ...identity,
                        kind: SESSION_PREPARE_KIND,
                        requestId: "prepare-native-browser",
                    }),
                );
                await prepared;
                const homeListing = waitForProtocolKind(socket, "workspace.entries");
                socket.send(
                    JSON.stringify({
                        kind: "workspace.list",
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
                    const result = new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
                        const cleanup = (): void => {
                            socket.removeEventListener("message", onMessage);
                            socket.removeEventListener("close", onClose);
                        };
                        const onClose = (): void => {
                            cleanup();
                            reject(new Error("The product rejected native session management"));
                        };
                        const onMessage = (event: MessageEvent<unknown>): void => {
                            if (typeof event.data !== "string") {
                                return;
                            }
                            const value: unknown = JSON.parse(event.data);
                            if (!isRecord(value)) {
                                return;
                            }
                            if (
                                value["kind"] === RUNTIME_STATUS_KIND &&
                                decodeRuntimeStatusEvent(event.data).online === false
                            ) {
                                cleanup();
                                reject(new Error("The local Runtime disconnected during native session management"));
                                return;
                            }
                            if (value["requestId"] !== requestId) {
                                return;
                            }
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
                    });
                    socket.send(
                        JSON.stringify({
                            ...identity,
                            ...fields,
                            kind: "native.session.request",
                            requestId,
                        }),
                    );
                    return await result;
                };
                const listing = await request({ action: "list", cursor: null });
                expect(listing).toMatchObject({
                    action: "list",
                    entries: [
                        expect.objectContaining({
                            title: "Saved native conversation".padEnd(500, "x"),
                        }),
                    ],
                });
                const entries = listing["entries"];
                if (
                    !Array.isArray(entries) ||
                    !isRecord(entries[0]) ||
                    typeof entries[0]["entryId"] !== "string" ||
                    typeof entries[0]["directoryId"] !== "string"
                ) {
                    throw new Error("Expected a listed native session");
                }
                const projectDirectoryId = entries[0]["directoryId"];
                const projectListing = waitForProtocolKind(socket, "workspace.entries");
                socket.send(
                    JSON.stringify({
                        kind: "workspace.list",
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
                    directoryId: projectDirectoryId,
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
                expectSelectedImageHistory(preview["history"]);
                const previewDirectory = await fetch(projectSessionUrl(pairing, origin), {
                    headers: authenticatedHeaders(pairing),
                });
                expect(JSON.stringify(await previewDirectory.json())).not.toContain("read-only-preview");
                await external.close();
                await writeFile(join(environment.MOBIUS_FAKE_ACP_STATE_DIRECTORY, "pause-load"), "");
                const loading = waitForProtocolKind(socket, "session.info.updated");
                const cancellationId = crypto.randomUUID();
                const cancelledLoad = request(
                    {
                        action: "import",
                        directoryId: projectDirectoryId,
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
                await rm(join(environment.MOBIUS_FAKE_ACP_STATE_DIRECTORY, "pause-load"));
                socket.send(
                    JSON.stringify({
                        kind: "native.session.cancel",
                        requestId: cancellationId,
                        sessionId: identity.sessionId,
                    }),
                );
                const nextImport = request({
                    action: "import",
                    directoryId: projectDirectoryId,
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
                expectSelectedImageHistory(imported["history"]);
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
                    runBrowserPrompt(socket, "codex", "imported-chat", "Continue native context", projectDirectoryId),
                ).resolves.toBe("Codex turn 2: Continue native context");
                const history = await fetch(projectSessionUrl(pairing, origin, "imported-chat", "/messages"), {
                    headers: authenticatedHeaders(pairing),
                });
                const persisted = await history.json();
                expect(persisted).toMatchObject({
                    messages: expect.arrayContaining([
                        expect.objectContaining({
                            sessionId: "imported-chat",
                            prompt: "Continue native context",
                            response: "Codex turn 2: Continue native context",
                        }),
                    ]),
                });
                const forked = await request({
                    action: "fork",
                    directoryId: projectDirectoryId,
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
                    runBrowserPrompt(socket, "codex", "forked-chat", "Continue fork", projectDirectoryId),
                ).resolves.toBe("Codex turn 3: Continue fork");
                await expect(
                    runBrowserPrompt(socket, "codex", "imported-chat", "Continue original", projectDirectoryId),
                ).resolves.toBe("Codex turn 3: Continue original");
                const reopened = await request({
                    action: "import",
                    directoryId: projectDirectoryId,
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
                expect(
                    await request({
                        action: "delete",
                        directoryId: projectDirectoryId,
                        entryId: entries[0]["entryId"],
                    }),
                ).toMatchObject({
                    action: "delete",
                    deletedSessionIds: ["imported-chat"],
                });
                const retainedAuditHistory = await fetch(
                    projectSessionUrl(pairing, origin, "imported-chat", "/messages"),
                    { headers: authenticatedHeaders(pairing) },
                );
                await expect(retainedAuditHistory.json()).resolves.toMatchObject({
                    messages: expect.arrayContaining([
                        expect.objectContaining({
                            sessionId: "imported-chat",
                            prompt: "Continue original",
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
                        directoryId: projectDirectoryId,
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
            for (const [key, value] of previous) {
                restoreEnvironmentVariable(key, value);
            }
            vi.useRealTimers();
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    });

    it("Given a liveness-capable daemon, When it checks the relay connection, Then the relay acknowledges the exact heartbeat", {
        timeout: 30_000,
    }, async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-liveness-e2e-"));
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
            const pairingResponse = await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings`, origin), {
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
            });

            const heartbeatId = crypto.randomUUID();
            const acknowledgement = waitForProtocolKind(daemon, RUNTIME_HEARTBEAT_ACK_KIND);
            daemon.send(
                encodeRuntimeHeartbeatEvent({
                    heartbeatId,
                    kind: RUNTIME_HEARTBEAT_KIND,
                }),
            );

            expect(decodeRuntimeHeartbeatAckEvent(await acknowledgement).heartbeatId).toBe(heartbeatId);
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

    it("Given a running Attempt becomes indeterminate with buffered events, When its owning daemon reconnects and replays them, Then the terminal outcome commits without taking the Runtime offline", {
        timeout: 30_000,
    }, async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-buffered-recovery-e2e-"));
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
        const sockets: WebSocket[] = [];

        try {
            await waitForRelay(wrangler);
            const pairingResponse = await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings`, origin), {
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
            const staleDaemon = new WebSocket(paired.config.relayUrl);
            sockets.push(staleDaemon);
            await waitForSocketOpen(staleDaemon);
            const host = new WebSocket(hostSocketUrl(pairing, origin));
            sockets.push(host);
            await waitForRuntimeOnline(host);

            const commandId = crypto.randomUUID();
            const sessionId = crypto.randomUUID();
            const promptReceived = waitForProtocolKind(staleDaemon, SESSION_PROMPT_KIND);
            host.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: "workspace",
                    commandId,
                    directoryId: "default",
                    images: [],
                    kind: SESSION_PROMPT_KIND,
                    prompt: "continue until the connection drops",
                    resources: [],
                    sessionId,
                }),
            );
            expect(decodeSessionPromptCommand(await promptReceived).commandId).toBe(commandId);
            const startReceived = waitForProtocolKind(host, SESSION_STARTED_KIND);
            sendSessionEvent(
                staleDaemon,
                sessionId,
                encodeSessionStartedEvent({
                    attemptId: "buffered-recovery-attempt",
                    commandId,
                    kind: SESSION_STARTED_KIND,
                    sessionId,
                }),
            );
            await startReceived;

            const offline = waitForProtocolKind(host, RUNTIME_STATUS_KIND);
            staleDaemon.close(1000, "Simulate a lost daemon connection");
            expect(decodeRuntimeStatusEvent(await offline).online).toBe(false);
            const replacementOnline = waitForRuntimeOnline(host);
            const replacementDaemon = new WebSocket(paired.config.relayUrl);
            sockets.push(replacementDaemon);
            await waitForSocketOpen(replacementDaemon);
            await replacementOnline;

            const activityReceived = waitForProtocolKind(host, AGENT_ACTIVITY_KIND);
            const deltaReceived = waitForProtocolKind(host, AGENT_MESSAGE_DELTA_KIND);
            sendSessionEvent(
                replacementDaemon,
                sessionId,
                encodeAgentActivityEvent({
                    activityId: "buffered-recovery-activity",
                    activityType: "tool",
                    commandId,
                    content: [],
                    detail: { kind: "unrecorded" },
                    input: "{}",
                    kind: AGENT_ACTIVITY_KIND,
                    locations: [],
                    name: "terminal",
                    output: "buffered progress",
                    sequence: 0,
                    sessionId,
                    status: "running",
                    title: "Run terminal command",
                    toolKind: "execute",
                }),
            );
            sendSessionEvent(
                replacementDaemon,
                sessionId,
                encodeAgentMessageDeltaEvent({
                    commandId,
                    kind: AGENT_MESSAGE_DELTA_KIND,
                    sessionId,
                    text: "buffered before disconnect",
                }),
            );
            const [activityPayload, deltaPayload] = await Promise.all([activityReceived, deltaReceived]);
            expect(decodeAgentActivityEvent(activityPayload)).toMatchObject({
                activityId: "buffered-recovery-activity",
                output: "buffered progress",
            });
            expect(decodeAgentMessageDeltaEvent(deltaPayload).text).toBe("buffered before disconnect");
            const indeterminateHistory = await fetch(projectSessionUrl(pairing, origin, sessionId, "/messages"), {
                headers: authenticatedHeaders(pairing),
            });
            await expect(indeterminateHistory.json()).resolves.toEqual(
                expect.objectContaining({
                    messages: expect.arrayContaining([
                        expect.objectContaining({
                            attempt: expect.objectContaining({ kind: "indeterminate" }),
                            commandId,
                            response: "buffered before disconnect",
                        }),
                    ]),
                }),
            );

            const failureReceived = waitForProtocolKind(host, SESSION_FAILED_KIND);
            sendSessionEvent(
                replacementDaemon,
                sessionId,
                encodeSessionFailedEvent({
                    code: "acp_execution_failed",
                    commandId,
                    kind: SESSION_FAILED_KIND,
                    message: "ACP agent execution failed",
                    sessionId,
                }),
            );
            const failurePayload = await failureReceived;
            expect(decodeSessionFailedEvent(failurePayload)).toMatchObject({
                code: "acp_execution_failed",
                commandId,
            });
            expect(replacementDaemon.readyState).toBe(WebSocket.OPEN);

            const historyResponse = await fetch(projectSessionUrl(pairing, origin, sessionId, "/messages"), {
                headers: authenticatedHeaders(pairing),
            });
            expect(historyResponse.status).toBe(200);
            await expect(historyResponse.json()).resolves.toEqual(
                expect.objectContaining({
                    messages: expect.arrayContaining([
                        expect.objectContaining({
                            attempt: expect.objectContaining({
                                code: "acp_execution_failed",
                                kind: "failed",
                            }),
                            activities: expect.arrayContaining([
                                expect.objectContaining({
                                    activityId: "buffered-recovery-activity",
                                    output: "buffered progress",
                                }),
                            ]),
                            commandId,
                            response: "buffered before disconnect",
                        }),
                    ]),
                }),
            );
        } finally {
            for (const socket of sockets) {
                socket.close(1000, "Buffered recovery E2E complete");
            }
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

    it("Given a running Attempt, When a replacement daemon connects, Then the indeterminate outcome blocks overlap until explicit reconciliation", {
        timeout: 30_000,
    }, async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-recovery-e2e-"));
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
            const pairingResponse = await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings`, origin), {
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
            host = new WebSocket(hostSocketUrl(pairing, origin));
            await waitForRuntimeOnline(host);

            const stalledCommandId = crypto.randomUUID();
            const sessionId = crypto.randomUUID();
            const stalledPrompt = waitForProtocolKind(staleDaemon, SESSION_PROMPT_KIND);
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
                    resources: [],
                    sessionId,
                }),
            );
            expect(decodeSessionPromptCommand(await stalledPrompt).commandId).toBe(stalledCommandId);
            const observedStalledStart = waitForProtocolKind(host, SESSION_STARTED_KIND);
            sendSessionEvent(
                staleDaemon,
                sessionId,
                encodeSessionStartedEvent({
                    commandId: stalledCommandId,
                    kind: SESSION_STARTED_KIND,
                    attemptId: "stalled-attempt",
                    sessionId,
                }),
            );
            await observedStalledStart;

            replacementDaemon = new WebSocket(paired.config.relayUrl);
            await waitForSocketOpen(replacementDaemon);

            const recoveredHistoryResponse = await fetch(projectSessionUrl(pairing, origin, sessionId, "/messages"), {
                headers: authenticatedHeaders(pairing),
            });
            expect(recoveredHistoryResponse.status).toBe(200);
            await expect(recoveredHistoryResponse.json()).resolves.toEqual(
                expect.objectContaining({
                    messages: expect.arrayContaining([
                        expect.objectContaining({
                            attempt: expect.objectContaining({ kind: "indeterminate" }),
                            commandId: stalledCommandId,
                        }),
                    ]),
                }),
            );

            const rejectedCommandId = crypto.randomUUID();
            const rejectedFailure = waitForProtocolKind(host, SESSION_FAILED_KIND);
            host.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: "workspace",
                    commandId: rejectedCommandId,
                    directoryId: "default",
                    images: [],
                    kind: SESSION_PROMPT_KIND,
                    prompt: "must not overlap indeterminate work",
                    resources: [],
                    sessionId,
                }),
            );
            expect(decodeSessionFailedEvent(await rejectedFailure)).toMatchObject({
                code: "session_busy",
                commandId: rejectedCommandId,
                sessionId,
            });
            expect(host.readyState).toBe(WebSocket.OPEN);

            const reconciliationUrl = new URL(
                `${MOBIUS_API_PREFIX}/channels/${encodeURIComponent(pairing.channelId)}/sessions/${encodeURIComponent(sessionId)}/attempts/stalled-attempt/reconciliation`,
                origin,
            );
            const daemonToken = new URL(paired.config.relayUrl).searchParams.get("token");
            if (daemonToken === null) {
                throw new Error("The paired daemon credential is missing");
            }
            reconciliationUrl.searchParams.set("token", daemonToken);
            const reconciliation = await fetch(reconciliationUrl, {
                body: JSON.stringify({
                    outcome: {
                        error: {
                            code: "runtime_restarted",
                            message: "The replacement Runtime confirmed execution stopped",
                            retryable: true,
                        },
                        kind: "failed",
                    },
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            });
            expect(reconciliation.status).toBe(200);
            await expect(reconciliation.json()).resolves.toMatchObject({
                attemptId: "stalled-attempt",
                state: { kind: "failed" },
            });

            const nextCommandId = crypto.randomUUID();
            const nextPrompt = waitForProtocolKind(replacementDaemon, SESSION_PROMPT_KIND);
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
                    resources: [],
                    sessionId,
                }),
            );
            expect(decodeSessionPromptCommand(await nextPrompt).commandId).toBe(nextCommandId);
            const observedNextStart = waitForProtocolKind(host, SESSION_STARTED_KIND);
            sendSessionEvent(
                replacementDaemon,
                sessionId,
                encodeSessionStartedEvent({
                    commandId: nextCommandId,
                    kind: SESSION_STARTED_KIND,
                    attemptId: "replacement-attempt",
                    sessionId,
                }),
            );
            await observedNextStart;
            const observedCompletion = waitForProtocolKind(host, SESSION_COMPLETED_KIND);
            sendSessionEvent(
                replacementDaemon,
                sessionId,
                encodeSessionCompletedEvent({
                    commandId: nextCommandId,
                    kind: SESSION_COMPLETED_KIND,
                    sessionId,
                    stopReason: "end_turn",
                }),
            );
            await observedCompletion;

            const completedHistoryResponse = await fetch(projectSessionUrl(pairing, origin, sessionId, "/messages"), {
                headers: authenticatedHeaders(pairing),
            });
            await expect(completedHistoryResponse.json()).resolves.toEqual(
                expect.objectContaining({
                    messages: expect.arrayContaining([
                        expect.objectContaining({
                            attempt: expect.objectContaining({ kind: "succeeded" }),
                            commandId: nextCommandId,
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

    it("Given a local Agent turn is waiting for approval, When the relay connection is replaced and the daemon reconnects, Then the same turn completes without an Agent failure", {
        timeout: 30_000,
    }, async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-live-turn-reconnect-e2e-"));
        const port = await reservePort();
        const origin = `http://127.0.0.1:${port.toString()}`;
        const executableDirectory = join(temporaryDirectory, "bin");
        const workbuddyPath = join(executableDirectory, "codebuddy");
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousCopilotPath = process.env["MOBIUS_COPILOT_PATH"];
        const previousCursorPath = process.env["MOBIUS_CURSOR_PATH"];
        const previousDeepSeekPath = process.env["MOBIUS_DEEPSEEK_HARNESS_PATH"];
        const previousFakeAcpStateDirectory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        const previousGrokPath = process.env["MOBIUS_GROK_BUILD_PATH"];
        const previousHermesPath = process.env["MOBIUS_HERMES_PATH"];
        const previousOpenCodePath = process.env["MOBIUS_OPENCODE_PATH"];
        const previousPath = process.env["PATH"];
        const previousPiPath = process.env["MOBIUS_PI_PATH"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousWorkBuddyPath = process.env["MOBIUS_WORKBUDDY_PATH"];
        const previousGeminiPath = process.env["MOBIUS_GEMINI_PATH"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        await mkdir(executableDirectory, { mode: 0o700, recursive: true });
        await writeFile(workbuddyPath, agentExecutableSource("WorkBuddy", "1.0.0"), { mode: 0o700 });
        await chmod(workbuddyPath, 0o700);
        const missingAgentPath = join(temporaryDirectory, "missing-agent");
        process.env["MOBIUS_CODEX_PATH"] = missingAgentPath;
        process.env["MOBIUS_CLAUDE_PATH"] = missingAgentPath;
        process.env["MOBIUS_COPILOT_PATH"] = missingAgentPath;
        process.env["MOBIUS_CURSOR_PATH"] = missingAgentPath;
        process.env["MOBIUS_DEEPSEEK_HARNESS_PATH"] = missingAgentPath;
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = join(temporaryDirectory, "native");
        process.env["MOBIUS_GROK_BUILD_PATH"] = missingAgentPath;
        process.env["MOBIUS_HERMES_PATH"] = missingAgentPath;
        process.env["MOBIUS_OPENCODE_PATH"] = missingAgentPath;
        process.env["MOBIUS_PI_PATH"] = missingAgentPath;
        process.env["MOBIUS_STATE_DIRECTORY"] = temporaryDirectory;
        process.env["MOBIUS_WORKBUDDY_PATH"] = workbuddyPath;
        process.env["MOBIUS_GEMINI_PATH"] = missingAgentPath;
        process.env["PATH"] = `${executableDirectory}${delimiter}${previousPath ?? ""}`;
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
            const pairingResponse = await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings`, origin), { method: "POST" });
            const pairing = decodeBrowserPairing(await pairingResponse.json());
            const paired = await pairLocalMachine([
                "--url",
                origin,
                "--code",
                pairing.pairingCode,
                "--workspace",
                repositoryRoot,
            ]);
            const audit = new AuditStore(paired.config.auditDatabasePath);
            const daemonController = new AbortController();
            const daemonRun = runDaemon(paired.config, audit, daemonController.signal);
            try {
                const host = new WebSocket(hostSocketUrl(pairing, origin));
                const sockets = [host];
                try {
                    await waitForRuntimeOnline(host);
                    const sessionId = crypto.randomUUID();
                    const permissionArrived = waitForProtocolKind(host, SESSION_PERMISSION_REQUESTED_KIND);
                    const prompt = startBrowserPrompt(host, "workbuddy", sessionId, "exercise ACP controls");
                    const permission = decodeSessionPermissionRequestedEvent(await permissionArrived);

                    const replacementDaemon = new WebSocket(paired.config.relayUrl);
                    sockets.push(replacementDaemon);
                    await waitForSocketOpen(replacementDaemon);
                    const reconnected = waitForRuntimeReconnect(host);
                    replacementDaemon.close(1000, "Simulate a transient relay loss");
                    await reconnected;

                    const elicitationArrived = waitForProtocolKind(host, SESSION_ELICITATION_REQUESTED_KIND);
                    host.send(
                        encodeSessionPermissionRespondCommand({
                            interactionId: permission.interactionId,
                            kind: "session.permission.respond",
                            optionId: "allow-once",
                            outcome: "selected",
                            sessionId,
                        }),
                    );
                    const elicitation = decodeSessionElicitationRequestedEvent(await elicitationArrived);
                    host.send(
                        encodeSessionElicitationRespondCommand({
                            action: "accept",
                            content: JSON.stringify({ branch: "reconnect-safe" }),
                            interactionId: elicitation.interactionId,
                            kind: "session.elicitation.respond",
                            sessionId,
                        }),
                    );

                    await expect(prompt.result).resolves.toMatchObject({
                        stopReason: "end_turn",
                        text: expect.stringContaining("reconnect-safe"),
                    });
                    const historyResponse = await fetch(projectSessionUrl(pairing, origin, sessionId, "/messages"), {
                        headers: authenticatedHeaders(pairing),
                    });
                    await expect(historyResponse.json()).resolves.toEqual(
                        expect.objectContaining({
                            messages: expect.arrayContaining([
                                expect.objectContaining({
                                    attempt: expect.objectContaining({ kind: "succeeded" }),
                                    commandId: prompt.commandId,
                                    response: expect.stringContaining("reconnect-safe"),
                                }),
                            ]),
                        }),
                    );
                } finally {
                    for (const socket of sockets) {
                        socket.close(1000, "Live turn reconnect E2E complete");
                    }
                }
            } finally {
                daemonController.abort();
                await daemonRun;
                audit.close();
            }
        } finally {
            await stopProcess(wrangler);
            restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MOBIUS_COPILOT_PATH", previousCopilotPath);
            restoreEnvironmentVariable("MOBIUS_CURSOR_PATH", previousCursorPath);
            restoreEnvironmentVariable("MOBIUS_DEEPSEEK_HARNESS_PATH", previousDeepSeekPath);
            restoreEnvironmentVariable("MOBIUS_FAKE_ACP_STATE_DIRECTORY", previousFakeAcpStateDirectory);
            restoreEnvironmentVariable("MOBIUS_GROK_BUILD_PATH", previousGrokPath);
            restoreEnvironmentVariable("MOBIUS_HERMES_PATH", previousHermesPath);
            restoreEnvironmentVariable("MOBIUS_OPENCODE_PATH", previousOpenCodePath);
            restoreEnvironmentVariable("MOBIUS_PI_PATH", previousPiPath);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("MOBIUS_WORKBUDDY_PATH", previousWorkBuddyPath);
            restoreEnvironmentVariable("MOBIUS_GEMINI_PATH", previousGeminiPath);
            restoreEnvironmentVariable("PATH", previousPath);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            await rm(temporaryDirectory, { recursive: true });
        }
    });

    it("Given Codex and Pi are ready while Claude Code needs an integration, When the browser installs that integration and the daemon restarts, Then all Agent details, responses, usage, and Pi recovery persist", {
        timeout: 90_000,
    }, async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-pairing-e2e-"));
        const port = await reservePort();
        const origin = `http://127.0.0.1:${port.toString()}`;
        const executableDirectory = join(temporaryDirectory, "bin");
        const codexPath = join(executableDirectory, "codex");
        const codexAdapterPath = join(executableDirectory, "codex-acp");
        const claudePath = join(executableDirectory, "claude");
        const unusableClaudeAdapterPath = join(executableDirectory, "claude-agent-acp");
        const piPath = join(executableDirectory, "pi");
        const piAdapterPath = join(executableDirectory, "pi-acp");
        const packageManagerPath = join(executableDirectory, "npm");
        const packageManagerRecordPath = join(temporaryDirectory, "adapter-package-requests.txt");
        await mkdir(executableDirectory, { mode: 0o700 });
        await Promise.all([
            writeFile(codexPath, agentExecutableSource("Codex", "codex 0.153.0"), {
                mode: 0o700,
            }),
            writeFile(codexAdapterPath, adapterExecutableSource("CODEX_PATH", "codex-acp 1.8.0"), { mode: 0o700 }),
            writeFile(claudePath, agentExecutableSource("Claude Code", "2.1.138 (Claude Code)"), { mode: 0o700 }),
            writeFile(
                unusableClaudeAdapterPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("claude-agent-acp 0.73.0\\n");
} else {
  process.exit(1);
}
`),
                { mode: 0o700 },
            ),
            writeFile(
                piPath,
                executableSource(`
if (process.argv.includes("--version")) {
  process.stdout.write("0.85.0\\n");
} else {
  if (!process.argv.includes("--mode") || !process.argv.includes("rpc")) {
    process.exit(90);
  }
  if (process.env.MOBIUS_FAKE_ACP_STATE_DIRECTORY !== undefined) {
    process.env.MOBIUS_FAKE_ACP_STATE_DIRECTORY += "/pi";
  }
  process.argv.push("--agent-name", "Pi");
  await import(${JSON.stringify(new URL(`file://${fakeAgentPath}`).toString())});
}
`),
                { mode: 0o700 },
            ),
            writeFile(
                piAdapterPath,
                executableSource(`
import { spawn } from "node:child_process";
const executable = process.env.PI_ACP_PI_COMMAND;
if (executable === undefined) process.exit(91);
const child = spawn(executable, ["--mode", "rpc"], {
  env: process.env,
  stdio: "inherit",
});
child.once("error", () => process.exit(92));
child.once("exit", (code) => process.exit(code ?? 93));
`),
                { mode: 0o700 },
            ),
            writeFile(packageManagerPath, packageManagerExecutableSource(packageManagerRecordPath), { mode: 0o700 }),
        ]);
        await Promise.all(
            [
                codexPath,
                codexAdapterPath,
                claudePath,
                unusableClaudeAdapterPath,
                piPath,
                piAdapterPath,
                packageManagerPath,
            ].map(async (path) => await chmod(path, 0o700)),
        );
        const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
        const previousCodexAdapterPath = process.env["MOBIUS_CODEX_ACP_PATH"];
        const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
        const previousClaudeAdapterPath = process.env["MOBIUS_CLAUDE_ACP_PATH"];
        const previousCopilotPath = process.env["MOBIUS_COPILOT_PATH"];
        const previousPiPath = process.env["MOBIUS_PI_PATH"];
        const previousPiAdapterPath = process.env["MOBIUS_PI_ACP_PATH"];
        const previousDeepSeekHarnessPath = process.env["MOBIUS_DEEPSEEK_HARNESS_PATH"];
        const previousHermesPath = process.env["MOBIUS_HERMES_PATH"];
        const previousOpenCodePath = process.env["MOBIUS_OPENCODE_PATH"];
        const previousCursorPath = process.env["MOBIUS_CURSOR_PATH"];
        const previousGrokBuildPath = process.env["MOBIUS_GROK_BUILD_PATH"];
        const previousWorkBuddyPath = process.env["MOBIUS_WORKBUDDY_PATH"];
        const previousGeminiPath = process.env["MOBIUS_GEMINI_PATH"];
        const previousFakeAcpStateDirectory = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
        const previousPath = process.env["PATH"];
        const previousNoProxy = process.env["NO_PROXY"];
        const previousLowerNoProxy = process.env["no_proxy"];
        process.env["MOBIUS_CODEX_PATH"] = codexPath;
        process.env["MOBIUS_CODEX_ACP_PATH"] = codexAdapterPath;
        process.env["MOBIUS_CLAUDE_PATH"] = claudePath;
        delete process.env["MOBIUS_CLAUDE_ACP_PATH"];
        process.env["MOBIUS_PI_PATH"] = piPath;
        process.env["MOBIUS_PI_ACP_PATH"] = piAdapterPath;
        const unavailableAgentDirectory = join(temporaryDirectory, "unavailable-agents");
        process.env["MOBIUS_COPILOT_PATH"] = join(unavailableAgentDirectory, "copilot");
        process.env["MOBIUS_DEEPSEEK_HARNESS_PATH"] = join(unavailableAgentDirectory, "dsh");
        process.env["MOBIUS_HERMES_PATH"] = join(unavailableAgentDirectory, "hermes");
        process.env["MOBIUS_OPENCODE_PATH"] = join(unavailableAgentDirectory, "opencode");
        process.env["MOBIUS_CURSOR_PATH"] = join(unavailableAgentDirectory, "cursor-agent");
        process.env["MOBIUS_GROK_BUILD_PATH"] = join(unavailableAgentDirectory, "grok");
        process.env["MOBIUS_WORKBUDDY_PATH"] = join(unavailableAgentDirectory, "codebuddy");
        process.env["MOBIUS_GEMINI_PATH"] = join(unavailableAgentDirectory, "gemini");
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = join(temporaryDirectory, "native");
        process.env["MOBIUS_STATE_DIRECTORY"] = temporaryDirectory;
        process.env["PATH"] = executableDirectory;
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
                env: {
                    ...process.env,
                    PATH: previousPath ?? "",
                    WRANGLER_SEND_METRICS: "false",
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        try {
            await waitForRelay(wrangler);
            const healthResponse = await fetch(new URL(`${MOBIUS_API_PREFIX}/health`, origin));
            expect(healthResponse.status).toBe(200);
            await expect(healthResponse.json()).resolves.toEqual({
                service: "mobius-relay",
                status: "ok",
            });
            const pairingResponse = await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings`, origin), {
                method: "POST",
            });
            expect(pairingResponse.status).toBe(201);
            const pairingBody: unknown = await pairingResponse.json();
            expect(pairingBody).toEqual(
                expect.objectContaining({
                    hostToken: expect.any(String),
                    projectId: expect.any(String),
                    tenantId: expect.any(String),
                }),
            );
            const pairing = decodeBrowserPairing(pairingBody);
            const paired = await pairLocalMachine([
                "--url",
                origin,
                "--code",
                pairing.pairingCode,
                "--workspace",
                repositoryRoot,
            ]);
            expect(new URL(paired.channelUrl).pathname).toBe(`/channels/${pairing.channelId}`);
            expect(paired.config.relayUrl.pathname).toBe(`${MOBIUS_API_PREFIX}/channels/${pairing.channelId}/daemon`);
            const initiallyResumed = await resumeLocalMachine(["--channel", pairing.channelId]);
            expect(initiallyResumed.channelUrl).toBe(paired.channelUrl);
            expect(initiallyResumed.config.defaultWorkspace).toBe(paired.config.defaultWorkspace);
            const savedConnection = await readFile(paired.connectionPath, "utf8");
            const resumed = await resumeLocalMachine(["--channel", pairing.channelId]);
            expect(resumed.config.defaultWorkspace).toBe(await realpath(repositoryRoot));
            await writeFile(paired.connectionPath, savedConnection.replace("\n}\n", ',\n  "unexpected": true\n}\n'), {
                mode: 0o600,
            });
            await expect(resumeLocalMachine(["--channel", pairing.channelId])).rejects.toMatchObject({
                code: "invalid_connection",
            });
            await writeFile(paired.connectionPath, savedConnection, {
                mode: 0o600,
            });
            const repeatedClaimResponse = await fetch(new URL(`${MOBIUS_API_PREFIX}/pairings/claim`, origin), {
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
            });
            expect(repeatedClaimResponse.status).toBe(400);
            const publicChannelResponse = await fetch(
                new URL(`${MOBIUS_API_PREFIX}/channels/${encodeURIComponent(pairing.channelId)}`, origin),
            );
            expect(publicChannelResponse.status).toBe(401);
            const authorizedChannelResponse = await fetch(
                new URL(`${MOBIUS_API_PREFIX}/channels/${encodeURIComponent(pairing.channelId)}`, origin),
                { headers: authenticatedHeaders(pairing) },
            );
            expect(authorizedChannelResponse.status).toBe(200);
            const publicChannel: unknown = await authorizedChannelResponse.json();
            expect(publicChannel).toMatchObject({
                agents: [
                    {
                        agentPath: codexPath,
                        agentVersion: "codex 0.153.0",
                        capabilities: expect.objectContaining({
                            imagePrompt: true,
                            loadSession: true,
                        }),
                        id: "codex",
                        label: "Codex",
                    },
                    {
                        agentPath: piPath,
                        agentVersion: "0.85.0",
                        capabilities: expect.objectContaining({
                            imagePrompt: true,
                            loadSession: true,
                        }),
                        id: "pi",
                        label: "Pi",
                    },
                ],
                channelId: pairing.channelId,
                installableAgents: [
                    {
                        agentPath: claudePath,
                        agentVersion: "2.1.138 (Claude Code)",
                        id: "claude",
                        label: "Claude Code",
                        status: "integration_not_installed",
                    },
                    {
                        id: "github-copilot-cli",
                        label: "GitHub Copilot CLI",
                        status: "agent_not_installed",
                    },
                    {
                        id: "deepseek-harness",
                        label: "DeepSeek Harness",
                        status: "agent_not_installed",
                    },
                    {
                        id: "hermes",
                        label: "Hermes Agent",
                        status: "agent_not_installed",
                    },
                    {
                        id: "opencode",
                        label: "OpenCode",
                        status: "agent_not_installed",
                    },
                    {
                        id: "cursor",
                        label: "Cursor CLI",
                        status: "agent_not_installed",
                    },
                    {
                        id: "grok-build",
                        label: "Grok Build",
                        status: "agent_not_installed",
                    },
                    {
                        id: "workbuddy",
                        label: "WorkBuddy",
                        status: "agent_not_installed",
                    },
                    {
                        id: "gemini-cli",
                        label: "Gemini CLI",
                        status: "agent_not_installed",
                    },
                ],
                machineName: expect.any(String),
                workspaceName: expect.any(String),
            });
            expect(JSON.stringify(publicChannel)).not.toContain(codexAdapterPath);
            const catalogEndpoint = new URL(paired.config.relayUrl);
            catalogEndpoint.protocol = "http:";
            catalogEndpoint.pathname = catalogEndpoint.pathname.replace(/\/daemon$/, "/catalog");
            catalogEndpoint.searchParams.set("token", "invalid");
            const unauthorizedCatalogUpdate = await fetch(catalogEndpoint, {
                body: JSON.stringify({
                    agents: [
                        {
                            agentPath: codexPath,
                            agentVersion: "codex 0.153.0",
                            capabilities: verifiedAgentCapabilities,
                            id: "codex",
                            label: "Codex",
                        },
                    ],
                    installableAgents: [],
                }),
                headers: { "content-type": "application/json" },
                method: "PUT",
            });
            expect(unauthorizedCatalogUpdate.status).toBe(401);
            catalogEndpoint.search = paired.config.relayUrl.search;
            const injectedCatalogUpdate = await fetch(catalogEndpoint, {
                body: JSON.stringify({
                    agents: [
                        {
                            capabilities: verifiedAgentCapabilities,
                            id: "codex",
                            label: "Codex",
                            path: codexPath,
                        },
                    ],
                    installableAgents: [],
                }),
                headers: { "content-type": "application/json" },
                method: "PUT",
            });
            expect(injectedCatalogUpdate.status).toBe(400);
            const wrongRoleResponse = await fetch(
                new URL(
                    `${MOBIUS_API_PREFIX}/channels/${encodeURIComponent(pairing.channelId)}/daemon?token=invalid`,
                    origin,
                ),
            );
            expect(wrongRoleResponse.status).toBe(401);

            const audit = new AuditStore(paired.config.auditDatabasePath);
            const daemonController = new AbortController();
            const piSessionId = crypto.randomUUID();
            const daemonRun = runDaemon(resumed.config, audit, daemonController.signal);
            try {
                const socket = new WebSocket(hostSocketUrl(pairing, origin));
                try {
                    await waitForRuntimeOnline(socket);
                    const awaitingIntegrationDescriptor = await fetch(
                        new URL(`${MOBIUS_API_PREFIX}/channels/${encodeURIComponent(pairing.channelId)}`, origin),
                        { headers: authenticatedHeaders(pairing) },
                    );
                    await expect(awaitingIntegrationDescriptor.json()).resolves.toMatchObject({
                        agents: [
                            {
                                agentPath: codexPath,
                                agentVersion: "codex 0.153.0",
                                capabilities: expect.objectContaining({
                                    imagePrompt: true,
                                    loadSession: true,
                                }),
                                id: "codex",
                                label: "Codex",
                            },
                            {
                                agentPath: piPath,
                                agentVersion: "0.85.0",
                                capabilities: expect.objectContaining({
                                    imagePrompt: true,
                                    loadSession: true,
                                }),
                                id: "pi",
                                label: "Pi",
                            },
                        ],
                        installableAgents: [
                            {
                                agentPath: claudePath,
                                agentVersion: "2.1.138 (Claude Code)",
                                id: "claude",
                                label: "Claude Code",
                                status: "integration_not_installed",
                            },
                            {
                                id: "github-copilot-cli",
                                label: "GitHub Copilot CLI",
                                status: "agent_not_installed",
                            },
                            {
                                id: "deepseek-harness",
                                label: "DeepSeek Harness",
                                status: "agent_not_installed",
                            },
                            {
                                id: "hermes",
                                label: "Hermes Agent",
                                status: "agent_not_installed",
                            },
                            {
                                id: "opencode",
                                label: "OpenCode",
                                status: "agent_not_installed",
                            },
                            {
                                id: "cursor",
                                label: "Cursor CLI",
                                status: "agent_not_installed",
                            },
                            {
                                id: "grok-build",
                                label: "Grok Build",
                                status: "agent_not_installed",
                            },
                            {
                                id: "workbuddy",
                                label: "WorkBuddy",
                                status: "agent_not_installed",
                            },
                            {
                                id: "gemini-cli",
                                label: "Gemini CLI",
                                status: "agent_not_installed",
                            },
                        ],
                    });
                    await expect(readFile(packageManagerRecordPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

                    const integrationRequestId = crypto.randomUUID();
                    const integrationCompleted = waitForProtocolKinds(
                        socket,
                        [AGENT_INSTALL_COMPLETED_KIND, AGENT_INSTALL_FAILED_KIND],
                        30_000,
                    );
                    const integrationStarted = waitForProtocolKinds(socket, [AGENT_INSTALL_STARTED_KIND], 30_000);
                    socket.send(
                        encodeAgentInstallRequestCommand({
                            agentId: "claude",
                            kind: AGENT_INSTALL_REQUEST_KIND,
                            requestId: integrationRequestId,
                        }),
                    );
                    await integrationStarted;
                    const integrationResult = await integrationCompleted;
                    if (decodeMessageKind(integrationResult) === AGENT_INSTALL_FAILED_KIND) {
                        throw new Error(
                            `Integration installation failed: ${JSON.stringify(decodeAgentInstallFailedEvent(integrationResult))}`,
                        );
                    }
                    expect(decodeAgentInstallCompletedEvent(integrationResult)).toMatchObject({
                        agentId: "claude",
                        requestId: integrationRequestId,
                    });
                    await expect(readFile(packageManagerRecordPath, "utf8")).resolves.toBe(
                        "@agentclientprotocol/claude-agent-acp@0.73.0\n",
                    );
                    const integratedDescriptor = await fetch(
                        new URL(`${MOBIUS_API_PREFIX}/channels/${encodeURIComponent(pairing.channelId)}`, origin),
                        { headers: authenticatedHeaders(pairing) },
                    );
                    await expect(integratedDescriptor.json()).resolves.toMatchObject({
                        agents: [
                            { id: "codex", label: "Codex" },
                            {
                                agentPath: claudePath,
                                agentVersion: "2.1.138 (Claude Code)",
                                id: "claude",
                                label: "Claude Code",
                            },
                            { id: "pi", label: "Pi" },
                        ],
                    });
                    await expect(
                        runBrowserPrompt(
                            socket,
                            "unregistered-agent",
                            crypto.randomUUID(),
                            "must not affect executable lookup",
                        ),
                    ).rejects.toThrow("agent_not_ready");
                    const codexSessionId = crypto.randomUUID();
                    await expect(runBrowserPrompt(socket, "codex", codexSessionId, "first")).resolves.toBe(
                        "Codex turn 1: first",
                    );
                    await expect(runBrowserPrompt(socket, "codex", codexSessionId, "second")).resolves.toBe(
                        "Codex turn 2: second",
                    );
                    await expect(runBrowserPrompt(socket, "pi", piSessionId, "first")).resolves.toBe(
                        "Pi turn 1: first",
                    );
                    await expect(runBrowserPrompt(socket, "pi", piSessionId, "second")).resolves.toBe(
                        "Pi turn 2: second",
                    );
                    const usageSessions: string[] = [];
                    for (const [agent, label, total] of [
                        ["codex", "Codex", 1_000],
                        ["claude", "Claude", 1_100],
                    ] satisfies readonly (readonly [string, string, number])[]) {
                        const usageSessionId = crypto.randomUUID();
                        usageSessions.push(usageSessionId);
                        const preparedUsageSession = waitForProtocolKind(socket, SESSION_READY_KIND);
                        socket.send(
                            encodeSessionPrepareCommand({
                                additionalDirectoryIds: [],
                                agentId: agent,
                                bindingId: "workspace",
                                directoryId: "default",
                                kind: SESSION_PREPARE_KIND,
                                requestId: crypto.randomUUID(),
                                sessionId: usageSessionId,
                            }),
                        );
                        await preparedUsageSession;
                        for (const turn of [1, 2]) {
                            const running = startBrowserPrompt(socket, agent, usageSessionId, `report ${label} usage`);
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
                                            model_usage: [expect.objectContaining({ model: expect.any(String) })],
                                        },
                                    },
                                },
                            ]);
                            expect(JSON.stringify(result.usage)).not.toContain("privateData");
                        }
                    }
                    for (const [index, sessionId] of usageSessions.entries()) {
                        const usageHistory = await fetch(projectSessionUrl(pairing, origin, sessionId, "/events"), {
                            headers: authenticatedHeaders(pairing),
                        });
                        const page: unknown = await usageHistory.json();
                        if (!isRecord(page) || !Array.isArray(page["events"])) {
                            throw new Error("Expected a persisted session event page");
                        }
                        const persistedUsage = page["events"].flatMap((value: unknown) => {
                            if (!isRecord(value) || typeof value["payload"] !== "string") {
                                return [];
                            }
                            const payload: unknown = JSON.parse(value["payload"]);
                            return isRecord(payload) && payload["kind"] === SESSION_USAGE_UPDATED_KIND ? [payload] : [];
                        });
                        expect(persistedUsage).toEqual(
                            expect.arrayContaining([
                                expect.objectContaining({
                                    costAmount: 0.25,
                                    source: "context",
                                    used: 50_000,
                                }),
                                expect.objectContaining({
                                    source: "prompt",
                                    usage: expect.objectContaining({
                                        totalTokens: 2_000 + index * 200,
                                    }),
                                }),
                            ]),
                        );
                    }
                    const cancellationSessionId = crypto.randomUUID();
                    const startedCancellation = waitForProtocolKind(socket, SESSION_STARTED_KIND);
                    const cancellationActivity = waitForProtocolKind(socket, AGENT_ACTIVITY_KIND);
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
                        sessionId: cancellationSessionId,
                    });
                    socket.send(encodedCancellation);
                    expect(decodeSessionCancelCommand(encodedCancellation).commandId).toBe(cancellablePrompt.commandId);
                    await expect(cancellablePrompt.result).resolves.toMatchObject({
                        stopReason: "cancelled",
                    });
                    await expect(runBrowserPrompt(socket, "codex", cancellationSessionId, "continue")).resolves.toBe(
                        "Codex turn 2: continue",
                    );
                    const historyResponse = await fetch(
                        projectSessionUrl(pairing, origin, codexSessionId, "/messages"),
                        { headers: authenticatedHeaders(pairing) },
                    );
                    expect(historyResponse.status).toBe(200);
                    await expect(historyResponse.json()).resolves.toEqual(
                        expect.objectContaining({
                            messages: expect.arrayContaining([
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
                                    attempt: expect.objectContaining({ kind: "succeeded" }),
                                }),
                                expect.objectContaining({
                                    agentId: "codex",
                                    prompt: "second",
                                    response: "Codex turn 2: second",
                                    sessionId: codexSessionId,
                                    attempt: expect.objectContaining({ kind: "succeeded" }),
                                }),
                            ]),
                        }),
                    );
                    const cancellationHistory = await fetch(
                        projectSessionUrl(pairing, origin, cancellationSessionId, "/messages"),
                        { headers: authenticatedHeaders(pairing) },
                    );
                    await expect(cancellationHistory.json()).resolves.toEqual(
                        expect.objectContaining({
                            messages: expect.arrayContaining([
                                expect.objectContaining({
                                    attempt: expect.objectContaining({
                                        kind: "cancelled",
                                    }),
                                    commandId: cancellablePrompt.commandId,
                                    prompt: "wait until cancelled",
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
            const refreshed = await resumeLocalMachine(["--channel", pairing.channelId]);
            const refreshedAudit = new AuditStore(refreshed.config.auditDatabasePath);
            const refreshedController = new AbortController();
            const refreshedDaemon = runDaemon(refreshed.config, refreshedAudit, refreshedController.signal);
            const refreshedHost = new WebSocket(hostSocketUrl(pairing, origin));
            try {
                await waitForRuntimeOnline(refreshedHost);
                const refreshedDescriptor = await fetch(
                    new URL(`${MOBIUS_API_PREFIX}/channels/${encodeURIComponent(pairing.channelId)}`, origin),
                    { headers: authenticatedHeaders(pairing) },
                );
                await expect(refreshedDescriptor.json()).resolves.toMatchObject({
                    agents: [
                        {
                            agentPath: codexPath,
                            agentVersion: "codex 0.153.0",
                            capabilities: expect.objectContaining({
                                imagePrompt: true,
                                loadSession: true,
                            }),
                            id: "codex",
                            label: "Codex",
                        },
                        {
                            agentPath: claudePath,
                            agentVersion: "2.1.138 (Claude Code)",
                            capabilities: expect.objectContaining({
                                imagePrompt: true,
                                loadSession: true,
                            }),
                            id: "claude",
                            label: "Claude Code",
                        },
                        {
                            agentPath: piPath,
                            agentVersion: "0.85.0",
                            capabilities: expect.objectContaining({
                                imagePrompt: true,
                                loadSession: true,
                            }),
                            id: "pi",
                            label: "Pi",
                        },
                    ],
                    installableAgents: [
                        {
                            id: "github-copilot-cli",
                            label: "GitHub Copilot CLI",
                            status: "agent_not_installed",
                        },
                        {
                            id: "deepseek-harness",
                            label: "DeepSeek Harness",
                            status: "agent_not_installed",
                        },
                        {
                            id: "hermes",
                            label: "Hermes Agent",
                            status: "agent_not_installed",
                        },
                        {
                            id: "opencode",
                            label: "OpenCode",
                            status: "agent_not_installed",
                        },
                        {
                            id: "cursor",
                            label: "Cursor CLI",
                            status: "agent_not_installed",
                        },
                        {
                            id: "grok-build",
                            label: "Grok Build",
                            status: "agent_not_installed",
                        },
                        {
                            id: "workbuddy",
                            label: "WorkBuddy",
                            status: "agent_not_installed",
                        },
                        {
                            id: "gemini-cli",
                            label: "Gemini CLI",
                            status: "agent_not_installed",
                        },
                    ],
                });
                await expect(runBrowserPrompt(refreshedHost, "pi", piSessionId, "third")).resolves.toBe(
                    "Pi turn 3: third",
                );
            } finally {
                refreshedHost.close(1000, "Refreshed catalog E2E complete");
                refreshedController.abort();
                await refreshedDaemon;
                refreshedAudit.close();
            }
            await verifyActiveTurnHistory(paired.config.relayUrl, origin, pairing);
        } finally {
            await stopProcess(wrangler);
            restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
            restoreEnvironmentVariable("MOBIUS_CODEX_ACP_PATH", previousCodexAdapterPath);
            restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
            restoreEnvironmentVariable("MOBIUS_CLAUDE_ACP_PATH", previousClaudeAdapterPath);
            restoreEnvironmentVariable("MOBIUS_COPILOT_PATH", previousCopilotPath);
            restoreEnvironmentVariable("MOBIUS_PI_PATH", previousPiPath);
            restoreEnvironmentVariable("MOBIUS_PI_ACP_PATH", previousPiAdapterPath);
            restoreEnvironmentVariable("MOBIUS_DEEPSEEK_HARNESS_PATH", previousDeepSeekHarnessPath);
            restoreEnvironmentVariable("MOBIUS_HERMES_PATH", previousHermesPath);
            restoreEnvironmentVariable("MOBIUS_OPENCODE_PATH", previousOpenCodePath);
            restoreEnvironmentVariable("MOBIUS_CURSOR_PATH", previousCursorPath);
            restoreEnvironmentVariable("MOBIUS_GROK_BUILD_PATH", previousGrokBuildPath);
            restoreEnvironmentVariable("MOBIUS_WORKBUDDY_PATH", previousWorkBuddyPath);
            restoreEnvironmentVariable("MOBIUS_GEMINI_PATH", previousGeminiPath);
            restoreEnvironmentVariable("MOBIUS_FAKE_ACP_STATE_DIRECTORY", previousFakeAcpStateDirectory);
            restoreEnvironmentVariable("MOBIUS_STATE_DIRECTORY", previousStateDirectory);
            restoreEnvironmentVariable("PATH", previousPath);
            restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
            restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
            await rm(temporaryDirectory, { recursive: true });
        }
    });
});
