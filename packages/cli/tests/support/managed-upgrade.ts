import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
    decodeDaemonToServiceMessage,
    encodeSessionPermissionRespondCommand,
    encodeSessionPromptCommand,
    RUNTIME_WORKSPACE_BINDING_ID,
    type RuntimeUpgradeResult,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import cliPackage from "../../package.json" with { type: "json" };
import {
    openMobiusCliInstallation,
    openMobiusControlInstallation,
} from "../../src/daemon/pairing/pair-local-machine.ts";
import { ClaudeFixture } from "../support/agents/claude.ts";
import { CodexFixture } from "../support/agents/codex.ts";
import { writeCodexFaultLauncher } from "../support/agents/codex-process-fault.ts";
import { PiFixture } from "../support/agents/pi.ts";
import { installWorkspaceDaemonRelease } from "../support/installed-daemon-release.ts";
import { FakeAnthropicProvider } from "../support/llm/anthropic.ts";
import { FakeOpenAiProvider } from "../support/llm/openai.ts";
import { fakeProviderPrompts } from "../support/llm/scenarios.ts";
import { packedRelease } from "../support/packed-daemon-release.ts";

// The daemon switches only after this much idle time, checked once a minute.
const UPGRADE_QUIET_MILLISECONDS = 31 * 60_000;
const BACKGROUND_AGENT = {
    dispatchDescription: "Check in the background",
    dispatchPrompt: "Delegate the verification to a background helper",
    innerPrompt: "Use a shell tool successfully, then reply with your findings",
    innerReport: "BACKGROUND_HELPER_DONE",
    runInBackground: true,
} as const;

export function registerManagedUpgradeScenarios(
    scenarios: readonly {
        readonly agentId: "claude" | "codex" | "pi";
        readonly mode: "foreground" | "long-foreground" | "background" | "background-agent" | "endpoint-exit";
        readonly exitCode: 0 | 1;
        readonly taskCount: 1 | 2;
    }[],
): void {
    test.each(scenarios)(
        "Given $agentId has $mode work with $taskCount tasks exiting with $exitCode, When an automatic release is downloaded, Then the daemon waits for native work and result handling or owner cleanup before switching",
        async ({ agentId, mode, exitCode, taskCount }) => {
            const directory = await mkdtemp(join(tmpdir(), "mobius-active-upgrade-"));
            const signal = AbortSignal.timeout(180_000);
            const faultPath = join(directory, "codex-fault");
            const answering = Promise.withResolvers<void>();
            const releaseAnswer = Promise.withResolvers<void>();
            const taskStarted = Promise.withResolvers<void>();
            const releaseTask = Promise.withResolvers<void>();
            const releaseSecondTask = Promise.withResolvers<void>();
            const secondAnswering = Promise.withResolvers<void>();
            const releaseSecondAnswer = Promise.withResolvers<void>();
            const tasksCompleted = Promise.withResolvers<void>();
            const agentRunning = Promise.withResolvers<void>();
            const releaseAgent = Promise.withResolvers<void>();
            const agentResultHeld = Promise.withResolvers<void>();
            const releaseAgentResult = Promise.withResolvers<void>();
            const terminalTasks = new Set<string>();
            let startedTasks = 0;
            let heldAnswers = 0;
            const taskServer = createServer(async (_request, response) => {
                startedTasks++;
                const taskIndex = startedTasks;
                if (startedTasks === taskCount) {
                    taskStarted.resolve();
                }
                await (taskIndex === 1 ? releaseTask.promise : releaseSecondTask.promise);
                response.end("BACKGROUND_COMPLETED");
            });
            await using resources = new AsyncDisposableStack();
            resources.defer(async () => {
                releaseTask.resolve();
                releaseSecondTask.resolve();
                releaseAnswer.resolve();
                releaseSecondAnswer.resolve();
                releaseAgent.resolve();
                releaseAgentResult.resolve();
                taskServer.closeAllConnections();
                await new Promise<void>((done) => taskServer.close(() => done()));
            });
            await listen(taskServer);
            const command = `${process.execPath} -e "require('node:http').get('http://127.0.0.1:${port(taskServer)}/',r=>{r.pipe(process.stdout);r.on('end',()=>{process.exitCode=${exitCode}})})"`;
            let holdAnswer = mode === "foreground";
            const agent = await (async () => {
                if (agentId === "claude") {
                    const provider = resources.use(
                        await FakeAnthropicProvider.start("claude-sonnet-4-6", "UPGRADE_PRESERVED_REPLY", {
                            ...(mode === "foreground" || mode === "background-agent"
                                ? {}
                                : { bash: { command, runInBackground: mode === "background" } }),
                            ...(mode === "background-agent" ? { subagent: BACKGROUND_AGENT } : {}),
                            ...(mode === "background-agent"
                                ? {}
                                : {
                                      toolPrompt:
                                          taskCount === 2
                                              ? fakeProviderPrompts.twoTools
                                              : fakeProviderPrompts.successfulTool,
                                  }),
                            beforeFirstText: async (scenario, _signal, conversation) => {
                                if (mode === "background-agent") {
                                    // Hold the subagent's answer, then the root's handling of its result.
                                    if (!conversation.includes(BACKGROUND_AGENT.dispatchPrompt)) {
                                        if (conversation.includes(BACKGROUND_AGENT.innerPrompt)) {
                                            agentRunning.resolve();
                                            await releaseAgent.promise;
                                        }
                                    } else if (conversation.includes(BACKGROUND_AGENT.innerReport)) {
                                        agentResultHeld.resolve();
                                        await releaseAgentResult.promise;
                                    }
                                    return;
                                }
                                if (!holdAnswer || scenario.toolCalls === 0) {
                                    return;
                                }
                                heldAnswers++;
                                if (heldAnswers === 1 || taskCount === 1) {
                                    answering.resolve();
                                    await releaseAnswer.promise;
                                } else {
                                    secondAnswering.resolve();
                                    await releaseSecondAnswer.promise;
                                }
                            },
                        }),
                    );
                    const fixture = resources.use(await ClaudeFixture.create(provider));
                    const config = fixture.environment["CLAUDE_CONFIG_DIR"];
                    if (config === undefined) {
                        throw new Error("Missing Claude fixture configuration");
                    }
                    await mkdir(config, { recursive: true });
                    await writeFile(
                        join(config, "settings.json"),
                        JSON.stringify({
                            permissions: mode === "foreground" ? { ask: ["Bash"] } : { allow: ["Bash"] },
                        }),
                    );
                    return fixture;
                }
                const provider = resources.use(
                    await FakeOpenAiProvider.start(
                        agentId === "pi" ? "gpt-4.1" : "gpt-5.4",
                        "UPGRADE_PRESERVED_REPLY",
                        {
                            toolPrompt: fakeProviderPrompts.successfulTool,
                            toolSequence: [
                                agentId === "codex"
                                    ? {
                                          name: "exec",
                                          input: `text(await tools.exec_command({cmd:${JSON.stringify(command)},yield_time_ms:1,max_output_tokens:1000}));`,
                                      }
                                    : { name: "bash", input: JSON.stringify({ command }) },
                            ],
                        },
                    ),
                );
                if (agentId !== "codex") {
                    return resources.use(await PiFixture.create(provider));
                }
                const fixture = resources.use(await CodexFixture.create(provider));
                if (mode !== "endpoint-exit") {
                    return fixture;
                }
                const launcher = join(directory, "codex.mjs");
                await writeCodexFaultLauncher(fixture, launcher, faultPath);
                return { environment: { ...fixture.environment, MOBIUS_CODEX_PATH: launcher } };
            })();
            const environment = {
                ...process.env,
                ...agent.environment,
                MOBIUS_STATE_DIRECTORY: join(directory, "state"),
                MOBIUS_TEST_CLOCK_DIRECTORY: directory,
                NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import=${pathToFileURL(resolve(import.meta.dirname, "../support/daemon-upgrade-clock.ts")).href}`,
                NPM_CONFIG_CACHE: join(directory, "npm-cache"),
                NPM_CONFIG_REGISTRY: "",
            };
            const cli = async (args: readonly string[], deadline = signal): Promise<void> => {
                const child = spawn(
                    process.execPath,
                    [resolve(import.meta.dirname, "../../src/cli/entrypoint.ts"), ...args],
                    {
                        cwd: directory,
                        env: environment,
                        signal: deadline,
                        stdio: ["ignore", "pipe", "pipe"],
                    },
                );
                let output = "";
                child.stdout.on("data", (chunk: Buffer) => {
                    output += chunk.toString();
                });
                child.stderr.on("data", (chunk: Buffer) => {
                    output += chunk.toString();
                });
                await new Promise<void>((done, reject) => {
                    child.once("error", reject);
                    child.once("close", (code) => (code === 0 ? done() : reject(new Error(output))));
                });
            };
            const version = "99.0.1";
            const release = await packedRelease(directory, version, false, signal);
            const catalogs = new Map<string, string>();
            let origin = "";
            const server = createServer(async (request, response) => {
                const path = decodeURIComponent(request.url ?? "");
                if (path.startsWith("/@moxt-ai/mobius")) {
                    response.writeHead(200, { "content-type": "application/json" }).end(
                        JSON.stringify({
                            name: cliPackage.name,
                            "dist-tags": { latest: version },
                            versions: {
                                [version]: {
                                    name: cliPackage.name,
                                    version,
                                    bin: { mobius: "dist/cli.js" },
                                    dist: {
                                        tarball: `${origin}/release.tgz`,
                                        integrity: `sha512-${createHash("sha512").update(release).digest("base64")}`,
                                    },
                                },
                            },
                        }),
                    );
                } else if (path === "/release.tgz") {
                    response.writeHead(200).end(release);
                } else if (path.endsWith("/catalog") && request.method === "PUT") {
                    let body = "";
                    for await (const chunk of request) {
                        body += chunk.toString();
                    }
                    catalogs.set(path, body);
                    response.writeHead(204).end();
                } else if (catalogs.has(path)) {
                    response.writeHead(200, { "content-type": "application/json" }).end(catalogs.get(path));
                } else {
                    response.writeHead(404).end();
                }
            });
            const sockets = new WebSocketServer({ server });
            const connected = Promise.withResolvers<void>();
            const upgraded = Promise.withResolvers<RuntimeUpgradeResult>();
            const completed = new Set<string>();
            const nativeSessions = new Map<string, string>();
            const taskStatuses: string[] = [];
            const toolSessions = new Set<string>();
            const failures: string[] = [];
            const progressed = Promise.withResolvers<void>();
            const failed = Promise.withResolvers<never>();
            void failed.promise.catch(() => undefined);
            const wait = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, failed.promise]);
            const fail = (message: unknown): void => {
                failures.push(JSON.stringify(message));
                failed.reject(new Error(JSON.stringify(message)));
            };
            const replies: string[] = [];
            let permitted = Promise.withResolvers<{
                readonly interactionId: string;
                readonly optionId: string;
                readonly sessionId: string;
            }>();
            const completions = new Map<string, PromiseWithResolvers<void>>();
            let socket: WebSocket | undefined;
            sockets.on("connection", (connection) => {
                socket = connection;
                connection.on("message", (data) => {
                    const message = decodeDaemonToServiceMessage(data.toString());
                    if (message.kind === "runtime.heartbeat") {
                        connection.send(JSON.stringify({ kind: "runtime.heartbeat.ack" }));
                    }
                    if (message.kind === "runtime.upgrade.result") {
                        upgraded.resolve(message);
                    }
                    if (message.kind === "session.operation.failed") {
                        fail(message);
                    }
                    if (message.kind === "session.event.v2") {
                        for (const event of message.events) {
                            if (event.type === "acp" && event.payload.sessionUpdate === "tool_call") {
                                toolSessions.add(event.sessionId);
                            }
                            if (
                                event.type === "acp" &&
                                (event.payload.sessionUpdate === "tool_call" ||
                                    event.payload.sessionUpdate === "tool_call_update") &&
                                event.payload.backgroundTask !== undefined
                            ) {
                                taskStatuses.push(event.payload.backgroundTask.status);
                                if (
                                    event.payload.backgroundTask.status === "completed" ||
                                    event.payload.backgroundTask.status === "failed"
                                ) {
                                    terminalTasks.add(event.payload.backgroundTask.id);
                                    if (terminalTasks.size === taskCount) {
                                        tasksCompleted.resolve();
                                    }
                                }
                            }
                            // Claude registers a foreground command as a native task once it has
                            // run for two seconds; its 30-second progress beat comes later.
                            if (
                                event.type === "acp" &&
                                event.payload.sessionUpdate === "tool_call_update" &&
                                event.payload.status === "in_progress"
                            ) {
                                progressed.resolve();
                            }
                            if (
                                event.type === "acp" &&
                                event.payload.sessionUpdate === "agent_message_chunk" &&
                                event.payload.content.type === "text"
                            ) {
                                replies.push(event.payload.content.text);
                            }
                            if (event.type !== "lifecycle-metadata") {
                                continue;
                            }
                            if (
                                event.payload.kind === "prompt.failed" ||
                                event.payload.kind === "prompt.failed-before-start"
                            ) {
                                fail(event.payload);
                            }
                            if (event.payload.kind === "prompt.completed") {
                                completed.add(event.payload.commandId);
                                nativeSessions.set(event.payload.commandId, event.sessionId);
                                completions.get(event.payload.commandId)?.resolve();
                            }
                            if (event.payload.kind === "session.permission.requested") {
                                const option = event.payload.event.options.find((entry) => entry.kind === "allow_once");
                                if (option !== undefined) {
                                    permitted.resolve({
                                        interactionId: event.payload.event.interactionId,
                                        optionId: option.optionId,
                                        sessionId: event.payload.event.sessionId,
                                    });
                                }
                            }
                        }
                    }
                });
                connection.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
                connected.resolve();
            });
            const send = (message: string): void => {
                if (socket === undefined) {
                    throw new Error("The managed daemon is offline");
                }
                socket.send(message);
            };
            const prompt = (text: string, sessionId = `upgrade_${randomUUID()}`): string => {
                const commandId = randomUUID();
                completions.set(commandId, Promise.withResolvers<void>());
                send(
                    encodeSessionPromptCommand({
                        kind: "session.prompt",
                        commandId,
                        sessionId,
                        agentId,
                        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                        disposition: SessionPromptDisposition.Reject,
                        targetCommandId: "",
                        attachments: [],
                        prompt: text,
                    }),
                );
                return commandId;
            };
            const deferred = Promise.withResolvers<Record<string, unknown>>();
            let watcher: ReturnType<typeof watch> | undefined;
            const abort = (): void => {
                failed.reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
            try {
                await installWorkspaceDaemonRelease(environment.MOBIUS_STATE_DIRECTORY);
                await listen(server);
                origin = `http://127.0.0.1:${port(server)}`;
                environment.NPM_CONFIG_REGISTRY = origin;
                const installation = await openMobiusCliInstallation(signal, environment);
                await installation.saveConnection(
                    {
                        appId: "app_upgrade",
                        channelId: "active-upgrade",
                        runtimeId: "runtime_upgrade",
                        pairingId: "",
                        defaultWorkspace: directory,
                        relayOrigin: new URL(origin),
                        runtimeCredential: "r".repeat(43),
                    },
                    signal,
                );
                await cli(["start"]);
                await wait(connected.promise);
                const control = await openMobiusControlInstallation(signal, environment);
                const worker = await readFile(join(control.stateDirectory, "worker.lock"), "utf8");
                const logs = join(control.stateDirectory, "logs");
                watcher = watch(logs, () => {
                    void readFile(join(logs, "daemon.log"), "utf8").then(
                        (text) => {
                            const line = /\{[^\n]*"event":"daemon_upgrade_deferred"[^\n]*\}/u.exec(text)?.[0];
                            if (line !== undefined) {
                                deferred.resolve(JSON.parse(line));
                            }
                        },
                        () => undefined,
                    );
                });
                const advance = async (milliseconds: number): Promise<void> => {
                    const clock = await readFile(join(directory, `${worker.trim()}.clock`), "utf8");
                    await (await fetch(`http://127.0.0.1:${clock}/${milliseconds}`, { signal })).text();
                };
                const outcome = (): Promise<string> =>
                    wait(
                        Promise.race([
                            deferred.promise.then(() => "deferred"),
                            upgraded.promise.then(() => "upgraded"),
                        ]),
                    );
                if (mode === "long-foreground") {
                    const command = prompt(fakeProviderPrompts.successfulTool);
                    await wait(taskStarted.promise);
                    await wait(progressed.promise);
                    releaseTask.resolve();
                    await wait(completions.get(command)?.promise ?? Promise.reject(new Error("Missing completion")));
                    await advance(3_600_000);
                    expect(await outcome()).toBe("upgraded");
                    expect((await wait(upgraded.promise)).outcome.status).toBe("succeeded");
                    expect(failures).toEqual([]);
                    return;
                }
                if (mode === "background-agent") {
                    const dispatch = prompt(BACKGROUND_AGENT.dispatchPrompt);
                    await wait(agentRunning.promise);
                    await advance(3_600_000);
                    expect(await outcome()).toBe("deferred");
                    releaseAgent.resolve();
                    // The Agent finished but its result is still being handled after the
                    // quiet period has elapsed; the reply must still reach this worker.
                    await wait(agentResultHeld.promise);
                    await advance(UPGRADE_QUIET_MILLISECONDS);
                    releaseAgentResult.resolve();
                    await wait(completions.get(dispatch)?.promise ?? Promise.reject(new Error("Missing completion")));
                    expect(replies.join("")).toContain("UPGRADE_PRESERVED_REPLY");
                    expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(worker);
                    await advance(UPGRADE_QUIET_MILLISECONDS);
                    expect((await wait(upgraded.promise)).outcome.status).toBe("succeeded");
                    expect(taskStatuses).toContain("completed");
                    expect(failures).toEqual([]);
                    return;
                }
                const first = prompt(
                    taskCount === 2 ? fakeProviderPrompts.twoTools : fakeProviderPrompts.successfulTool,
                );
                let second: string | undefined;
                let permission: Awaited<typeof permitted.promise> | undefined;
                if (mode === "foreground" && agentId === "claude") {
                    const firstPermission = await wait(permitted.promise);
                    permitted = Promise.withResolvers();
                    send(
                        encodeSessionPermissionRespondCommand({
                            kind: "session.permission.respond",
                            ...firstPermission,
                            outcome: "selected",
                        }),
                    );
                    await wait(answering.promise);
                    second = prompt(fakeProviderPrompts.successfulTool);
                    permission = await wait(permitted.promise);
                } else {
                    await wait(taskStarted.promise);
                    if (mode !== "foreground") {
                        await wait(completions.get(first)?.promise ?? Promise.reject(new Error("Missing completion")));
                    }
                }
                await advance(3_600_000);
                expect(await outcome()).toBe("deferred");
                // The diagnostic names what holds the upgrade.
                expect(await deferred.promise).toMatchObject(
                    mode === "foreground"
                        ? { turns: second === undefined ? 1 : 2, backgroundRunning: 0, backgroundAwaitingResults: 0 }
                        : { turns: 0, backgroundRunning: 1, backgroundAwaitingResults: 0 },
                );
                if (mode !== "foreground") {
                    expect(taskStatuses).toContain("running");
                    const sessionId = nativeSessions.get(first);
                    if (sessionId === undefined) {
                        throw new Error("Missing native session identity");
                    }
                    const followup = prompt("Say hello", sessionId);
                    await wait(
                        completions.get(followup)?.promise ?? Promise.reject(new Error("Missing followup completion")),
                    );
                    expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(worker);
                }
                holdAnswer = true;
                if (mode === "endpoint-exit") {
                    await writeFile(faultPath, "idle-exit");
                } else {
                    releaseTask.resolve();
                }
                if (mode === "background" && agentId === "claude") {
                    await wait(answering.promise);
                    expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(worker);
                }
                if (taskCount === 2) {
                    releaseSecondTask.resolve();
                    await wait(tasksCompleted.promise);
                    releaseAnswer.resolve();
                    expect(
                        await wait(
                            Promise.race([
                                secondAnswering.promise.then(() => "processing"),
                                upgraded.promise.then(() => "upgraded"),
                            ]),
                        ),
                    ).toBe("processing");
                    // The second result is already held. Let a different session finish
                    // to observe that upgrade admission remains open during that hold.
                    holdAnswer = false;
                    const concurrent = prompt("Say hello");
                    expect(
                        await wait(
                            Promise.race([
                                (
                                    completions.get(concurrent)?.promise ??
                                    Promise.reject(new Error("Missing concurrent completion"))
                                ).then(() => "completed"),
                                upgraded.promise.then(() => "upgraded"),
                            ]),
                        ),
                    ).toBe("completed");
                    expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(worker);
                    expect(toolSessions).not.toContain(nativeSessions.get(concurrent));
                    releaseSecondAnswer.resolve();
                }
                releaseAnswer.resolve();
                await wait(completions.get(first)?.promise ?? Promise.reject(new Error("Missing first completion")));
                if (second !== undefined && permission !== undefined) {
                    expect(completed.has(second)).toBe(false);
                    expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(worker);
                    send(
                        encodeSessionPermissionRespondCommand({
                            kind: "session.permission.respond",
                            ...permission,
                            outcome: "selected",
                        }),
                    );
                    await wait(
                        completions.get(second)?.promise ?? Promise.reject(new Error("Missing second completion")),
                    );
                }
                // The user just got a reply; a follow-up must reach the same worker. The
                // endpoint-exit fault killed the first Session's Agent, so start another.
                const settled = prompt("Say hello", mode === "endpoint-exit" ? undefined : nativeSessions.get(first));
                await wait(
                    completions.get(settled)?.promise ?? Promise.reject(new Error("Missing settled completion")),
                );
                expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).toBe(worker);
                await advance(UPGRADE_QUIET_MILLISECONDS);
                const upgrade = await wait(upgraded.promise);
                expect(await readFile(join(control.stateDirectory, "logs", "daemon.log"), "utf8")).toContain(
                    '"event":"daemon_upgrade_released"',
                );
                expect(upgrade.outcome.status).toBe("succeeded");
                expect(upgrade.version).toBe(version);
                if (mode === "background") {
                    expect(taskStatuses).toContain(exitCode === 0 ? "completed" : "failed");
                }
                expect(failures).toEqual([]);
                expect(replies.join("")).toContain("UPGRADE_PRESERVED_REPLY");
                expect(await readFile(join(control.stateDirectory, "worker.lock"), "utf8")).not.toBe(worker);
            } finally {
                releaseTask.resolve();
                releaseSecondTask.resolve();
                releaseAnswer.resolve();
                releaseSecondAnswer.resolve();
                watcher?.close();
                signal.removeEventListener("abort", abort);
                await cli(["quit"], AbortSignal.timeout(20_000)).catch(() => undefined);
                for (const connection of sockets.clients) {
                    connection.terminate();
                }
                await new Promise<void>((done) => sockets.close(() => done()));
                server.closeAllConnections();
                await new Promise<void>((done) => server.close(() => done()));
                await rm(directory, { recursive: true, force: true });
            }
        },
        210_000,
    );
}
