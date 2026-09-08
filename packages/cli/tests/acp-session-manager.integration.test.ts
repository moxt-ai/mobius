import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { AcpSessionManager, createWritableAcpStream } from "../src/acp/session-manager.ts";
import { SqliteAcpSessionStore } from "../src/acp/session-store.ts";
import { LocalAgentDefinition } from "../src/config.ts";

const fakeAgentPath = fileURLToPath(new URL("../../../e2e/fixtures/fake-acp-agent/src/cli.ts", import.meta.url));

function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            return false;
        }
        throw error;
    }
}

describe("ACP conversation sessions", () => {
    it.skipIf(process.platform === "win32")(
        "Given a Pi ACP prompt hangs, When its outer deadline expires, Then Mobius reports a typed timeout and terminates the adapter and Pi child",
        async () => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-pi-prompt-timeout-"));
            const adapterPath = join(temporaryDirectory, "pi-acp");
            const piPidPath = join(temporaryDirectory, "pi.pid");
            await writeFile(
                adapterPath,
                `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const pidPath = process.env.MOBIUS_TEST_PI_PID_FILE;
if (pidPath === undefined) process.exit(81);
const child = spawn(process.execPath, [${JSON.stringify(fakeAgentPath)}, "--agent-name", "Pi"], {
  env: process.env,
  stdio: "inherit",
});
if (child.pid === undefined) process.exit(82);
writeFileSync(pidPath, child.pid.toString());
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.once("error", () => process.exit(83));
child.once("exit", (code) => process.exit(code ?? 84));
`,
                { mode: 0o700 },
            );
            await chmod(adapterPath, 0o700);
            vi.useFakeTimers({ toFake: ["clearTimeout", "setTimeout"] });
            const manager = new AcpSessionManager();
            const adapterBaseline = new LocalAgentDefinition("pi", "Pi", adapterPath, []);
            const agentBaseline = new LocalAgentDefinition("pi", "Pi", process.execPath, []);
            const agent = new LocalAgentDefinition(
                "pi",
                "Pi",
                adapterPath,
                [],
                { MOBIUS_TEST_PI_PID_FILE: piPidPath },
                "0.0.33",
                "0.85.0",
                adapterBaseline.adapterIdentity,
                agentBaseline.agentIdentity,
                1_000,
            );
            const activityStarted = Promise.withResolvers<void>();

            try {
                const hangingTurn = manager.runPrompt({
                    additionalDirectories: [],
                    agent,
                    commandId: "pi-hanging-command",
                    cwd: process.cwd(),
                    images: [],
                    onActivity: () => {
                        activityStarted.resolve();
                        return Promise.resolve();
                    },
                    onText: () => Promise.resolve(),
                    prompt: "wait until cancelled",
                    resources: [],
                    sessionId: "pi-hanging-conversation",
                    signal: new AbortController().signal,
                });
                await activityStarted.promise;

                await vi.advanceTimersByTimeAsync(1_000);

                await expect(hangingTurn).rejects.toMatchObject({
                    code: "prompt_timeout",
                });
                const piPid = Number.parseInt(await readFile(piPidPath, "utf8"), 10);
                expect(Number.isSafeInteger(piPid)).toBe(true);
                expect(processExists(piPid)).toBe(false);
            } finally {
                vi.useRealTimers();
                await manager.close();
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );

    it("Given a persisted Pi session and a restarted load-only adapter, When the conversation is prepared again, Then Mobius explicitly loads the native session before continuing", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-pi-load-session-"));
        const databasePath = join(temporaryDirectory, "sessions.sqlite");
        const agent = new LocalAgentDefinition(
            "pi",
            "Pi",
            process.execPath,
            [fakeAgentPath, "--agent-name", "Pi", "--load-only"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: temporaryDirectory },
            "0.0.33",
            "0.85.0",
        );
        const signal = new AbortController().signal;

        try {
            const firstStore = new SqliteAcpSessionStore(databasePath);
            const first = new AcpSessionManager(undefined, firstStore);
            const firstText: string[] = [];
            await first.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "pi-first-command",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    firstText.push(text);
                    return Promise.resolve();
                },
                prompt: "first",
                resources: [],
                sessionId: "persisted-pi-conversation",
                signal,
            });
            await first.close();
            firstStore.close();

            const secondStore = new SqliteAcpSessionStore(databasePath);
            const second = new AcpSessionManager(undefined, secondStore);
            try {
                await expect(
                    second.prepareSession({
                        additionalDirectories: [],
                        agent,
                        cwd: temporaryDirectory,
                        sessionId: "persisted-pi-conversation",
                        signal,
                    }),
                ).resolves.toMatchObject({ restored: true });
                const secondText: string[] = [];
                await second.runPrompt({
                    additionalDirectories: [],
                    agent,
                    commandId: "pi-second-command",
                    cwd: temporaryDirectory,
                    images: [],
                    onActivity: () => Promise.resolve(),
                    onText: (text) => {
                        secondText.push(text);
                        return Promise.resolve();
                    },
                    prompt: "second",
                    resources: [],
                    sessionId: "persisted-pi-conversation",
                    signal,
                });
                expect(firstText.join("")).toBe("Pi turn 1: first");
                expect(secondText.join("")).toBe("Pi turn 2: second");
            } finally {
                await second.close();
                secondStore.close();
            }
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given a prepared conversation has no turns, When its agent selection changes, Then the same Mobius session is rebound before the first prompt", async () => {
        const manager = new AcpSessionManager();
        const codex = new LocalAgentDefinition("codex", "Codex", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Codex",
        ]);
        const claude = new LocalAgentDefinition("claude", "Claude Code", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Claude Code",
        ]);

        try {
            await manager.prepareSession({
                additionalDirectories: [],
                agent: codex,
                cwd: process.cwd(),
                sessionId: "rebound-conversation",
                signal: new AbortController().signal,
            });
            await expect(
                manager.prepareSession({
                    additionalDirectories: [],
                    agent: claude,
                    cwd: process.cwd(),
                    sessionId: "rebound-conversation",
                    signal: new AbortController().signal,
                }),
            ).resolves.toMatchObject({ restored: false });

            const chunks: string[] = [];
            await manager.runPrompt({
                additionalDirectories: [],
                agent: claude,
                commandId: "command-after-rebind",
                cwd: process.cwd(),
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    chunks.push(text);
                    return Promise.resolve();
                },
                prompt: "selected agent",
                resources: [],
                sessionId: "rebound-conversation",
                signal: new AbortController().signal,
            });
            expect(chunks.join("")).toBe("Claude Code turn 1: selected agent");
        } finally {
            await manager.close();
        }
    });

    it("Given an unprompted ACP session survived a daemon restart, When its agent selection changes, Then the local runtime safely rebinds it", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-empty-rebind-"));
        const databasePath = join(temporaryDirectory, "sessions.sqlite");
        const codex = new LocalAgentDefinition("codex", "Codex", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Codex",
        ]);
        const claude = new LocalAgentDefinition("claude", "Claude Code", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Claude Code",
        ]);
        const signal = new AbortController().signal;

        try {
            const firstStore = new SqliteAcpSessionStore(databasePath);
            const first = new AcpSessionManager(undefined, firstStore);
            await first.prepareSession({
                additionalDirectories: [],
                agent: codex,
                cwd: temporaryDirectory,
                sessionId: "persisted-empty-conversation",
                signal,
            });
            await first.close();
            firstStore.close();

            const secondStore = new SqliteAcpSessionStore(databasePath);
            const second = new AcpSessionManager(undefined, secondStore);
            try {
                await expect(
                    second.prepareSession({
                        additionalDirectories: [],
                        agent: claude,
                        cwd: temporaryDirectory,
                        sessionId: "persisted-empty-conversation",
                        signal,
                    }),
                ).resolves.toMatchObject({ restored: false });
                const chunks: string[] = [];
                await second.runPrompt({
                    additionalDirectories: [],
                    agent: claude,
                    commandId: "command-after-restart-rebind",
                    cwd: temporaryDirectory,
                    images: [],
                    onActivity: () => Promise.resolve(),
                    onText: (text) => {
                        chunks.push(text);
                        return Promise.resolve();
                    },
                    prompt: "selected after restart",
                    resources: [],
                    sessionId: "persisted-empty-conversation",
                    signal,
                });
                expect(chunks.join("")).toBe("Claude Code turn 1: selected after restart");
            } finally {
                await second.close();
                secondStore.close();
            }
        } finally {
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given an Agent only persists a conversation after its first prompt, When an unprompted Mobius conversation prepares after a daemon restart, Then the local runtime replaces the empty native session without an agent toggle", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-empty-restart-"));
        const databasePath = join(temporaryDirectory, "sessions.sqlite");
        const nativeStateDirectory = join(temporaryDirectory, "native");
        const previousState = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = nativeStateDirectory;
        const codex = new LocalAgentDefinition("codex", "Codex", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Codex",
            "--persist-after-first-prompt",
        ]);
        const signal = new AbortController().signal;

        try {
            const firstStore = new SqliteAcpSessionStore(databasePath);
            const first = new AcpSessionManager(undefined, firstStore);
            await first.prepareSession({
                additionalDirectories: [],
                agent: codex,
                cwd: temporaryDirectory,
                sessionId: "empty-codex-conversation",
                signal,
            });
            await first.close();
            firstStore.close();

            const secondStore = new SqliteAcpSessionStore(databasePath);
            const second = new AcpSessionManager(undefined, secondStore);
            try {
                await expect(
                    second.prepareSession({
                        additionalDirectories: [],
                        agent: codex,
                        cwd: temporaryDirectory,
                        sessionId: "empty-codex-conversation",
                        signal,
                    }),
                ).resolves.toMatchObject({ restored: false });
                const chunks: string[] = [];
                await second.runPrompt({
                    additionalDirectories: [],
                    agent: codex,
                    commandId: "first-command-after-restart",
                    cwd: temporaryDirectory,
                    images: [],
                    onActivity: () => Promise.resolve(),
                    onText: (text) => {
                        chunks.push(text);
                        return Promise.resolve();
                    },
                    prompt: "continue without switching agents",
                    resources: [],
                    sessionId: "empty-codex-conversation",
                    signal,
                });
                expect(chunks.join("")).toBe("Codex turn 1: continue without switching agents");
            } finally {
                await second.close();
                secondStore.close();
            }
        } finally {
            if (previousState === undefined) {
                delete process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
            } else {
                process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = previousState;
            }
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it("Given an active ACP conversation, When a second turn is sent, Then the same Agent session remains alive", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("codex", "Codex", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "Codex",
        ]);
        const firstChunks: string[] = [];
        const secondChunks: string[] = [];

        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "command-first",
                cwd: process.cwd(),
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    firstChunks.push(text);
                    return Promise.resolve();
                },
                prompt: "first",
                resources: [],
                sessionId: "browser-conversation",
                signal: new AbortController().signal,
            });
            await manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "command-second",
                cwd: process.cwd(),
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    secondChunks.push(text);
                    return Promise.resolve();
                },
                prompt: "second",
                resources: [],
                sessionId: "browser-conversation",
                signal: new AbortController().signal,
            });
        } finally {
            await manager.close();
        }

        expect(firstChunks.join("")).toBe("Codex turn 1: first");
        expect(secondChunks.join("")).toBe("Codex turn 2: second");
    });

    it("Given an ACP agent announces a different session while creating one, When Mobius receives the created session, Then the local boundary rejects the queued update", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("deepseek", "DeepSeek Harness", process.execPath, [
            fakeAgentPath,
            "--agent-name",
            "DeepSeek Harness",
            "--announce-config-while-creating",
            "--announce-wrong-session-while-creating",
        ]);

        try {
            await expect(
                manager.prepareSession({
                    additionalDirectories: [],
                    agent,
                    cwd: process.cwd(),
                    sessionId: "deepseek-wrong-session-notification",
                    signal: new AbortController().signal,
                }),
            ).rejects.toMatchObject({ code: "invalid_agent_session" });
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP agent returns the standard authentication error, When Mobius starts its session, Then the local boundary preserves an authentication-required code", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("opencode", "OpenCode", process.execPath, [
            fakeAgentPath,
            "--authentication-required",
        ]);

        try {
            await expect(
                manager.prepareSession({
                    additionalDirectories: [],
                    agent,
                    cwd: process.cwd(),
                    sessionId: "authentication-required-session",
                    signal: new AbortController().signal,
                }),
            ).rejects.toMatchObject({ code: "authentication_required" });
        } finally {
            await manager.close();
        }
    });

    it("Given a turn is running, When it is cancelled, Then ACP stops that turn and keeps the session usable", async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-cancel-resume-"));
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition(
            "codex",
            "Codex",
            process.execPath,
            [fakeAgentPath, "--agent-name", "Codex"],
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: temporaryDirectory,
            },
        );
        const activityStarted = Promise.withResolvers<void>();

        try {
            const cancelledTurn = manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "command-cancelled",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => {
                    activityStarted.resolve();
                    return Promise.resolve();
                },
                onText: () => Promise.resolve(),
                prompt: "wait until cancelled",
                resources: [],
                sessionId: "cancelled-conversation",
                signal: new AbortController().signal,
            });
            await activityStarted.promise;

            await manager.cancelPrompt("cancelled-conversation");

            await expect(cancelledTurn).resolves.toEqual({
                stopReason: "cancelled",
            });
            const nextChunks: string[] = [];
            await manager.runPrompt({
                additionalDirectories: [],
                agent,
                commandId: "command-continue",
                cwd: temporaryDirectory,
                images: [],
                onActivity: () => Promise.resolve(),
                onText: (text) => {
                    nextChunks.push(text);
                    return Promise.resolve();
                },
                prompt: "continue",
                resources: [],
                sessionId: "cancelled-conversation",
                signal: new AbortController().signal,
            });
            expect(nextChunks.join("")).toBe("Codex turn 2: continue");
        } finally {
            await manager.close();
            await rm(temporaryDirectory, { force: true, recursive: true });
        }
    });

    it.skipIf(process.platform === "win32")(
        "Given an ACP Agent leaves a tool subprocess alive after cancelling, When the turn is cancelled, Then Mobius releases the process tree and resumes the saved session",
        async () => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), "mobius-acp-cancel-tree-"));
            const manager = new AcpSessionManager();
            const adapterPath = join(temporaryDirectory, "codex-acp");
            const childPidPath = join(temporaryDirectory, "tool-child.pid");
            await writeFile(
                adapterPath,
                `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const childPidPath = process.env.MOBIUS_TEST_CHILD_PID_FILE;
if (childPidPath === undefined) process.exit(81);
const tool = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60000)"], {
  detached: true,
  env: process.env,
  stdio: "ignore",
});
if (tool.pid === undefined) process.exit(82);
writeFileSync(childPidPath, tool.pid.toString());
const agent = spawn(process.execPath, [${JSON.stringify(fakeAgentPath)}, "--agent-name", "Codex"], {
  env: process.env,
  stdio: "inherit",
});
agent.once("error", () => process.exit(83));
agent.once("exit", (code) => process.exit(code ?? 84));
`,
                { mode: 0o700 },
            );
            await chmod(adapterPath, 0o700);
            const agent = new LocalAgentDefinition("codex", "Codex", adapterPath, [], {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: temporaryDirectory,
                MOBIUS_TEST_CHILD_PID_FILE: childPidPath,
            });
            const activityStarted = Promise.withResolvers<void>();
            let childPid = 0;

            try {
                const cancelledTurn = manager.runPrompt({
                    additionalDirectories: [],
                    agent,
                    commandId: "command-cancelled-tree",
                    cwd: temporaryDirectory,
                    images: [],
                    onActivity: () => {
                        activityStarted.resolve();
                        return Promise.resolve();
                    },
                    onText: () => Promise.resolve(),
                    prompt: "wait until cancelled",
                    resources: [],
                    sessionId: "cancelled-tree-conversation",
                    signal: new AbortController().signal,
                });
                await activityStarted.promise;
                childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
                expect(Number.isSafeInteger(childPid)).toBe(true);

                await manager.cancelPrompt("cancelled-tree-conversation");

                await expect(cancelledTurn).resolves.toEqual({
                    stopReason: "cancelled",
                });
                expect(processExists(childPid)).toBe(false);
                const nextChunks: string[] = [];
                await manager.runPrompt({
                    additionalDirectories: [],
                    agent,
                    commandId: "command-after-tree-cancel",
                    cwd: temporaryDirectory,
                    images: [],
                    onActivity: () => Promise.resolve(),
                    onText: (text) => {
                        nextChunks.push(text);
                        return Promise.resolve();
                    },
                    prompt: "continue",
                    resources: [],
                    sessionId: "cancelled-tree-conversation",
                    signal: new AbortController().signal,
                });
                expect(nextChunks.join("")).toBe("Codex turn 2: continue");
            } finally {
                await manager.close();
                if (childPid > 0 && processExists(childPid)) {
                    try {
                        process.kill(-childPid, "SIGKILL");
                    } catch {
                        // A concurrently exited test process no longer needs cleanup.
                    }
                }
                await rm(temporaryDirectory, { force: true, recursive: true });
            }
        },
    );

    it("Given an existing Agent conversation, When a caller changes its Agent identity, Then the local boundary rejects the request", async () => {
        const manager = new AcpSessionManager();
        const codex = new LocalAgentDefinition("codex", "Codex", process.execPath, [fakeAgentPath]);
        const claude = new LocalAgentDefinition("claude", "Claude Code", process.execPath, [fakeAgentPath]);

        try {
            await manager.runPrompt({
                additionalDirectories: [],
                agent: codex,
                commandId: "command-locked-first",
                cwd: process.cwd(),
                images: [],
                onActivity: () => Promise.resolve(),
                onText: () => Promise.resolve(),
                prompt: "first",
                resources: [],
                sessionId: "locked-conversation",
                signal: new AbortController().signal,
            });
            await expect(
                manager.runPrompt({
                    additionalDirectories: [],
                    agent: claude,
                    commandId: "command-locked-second",
                    cwd: process.cwd(),
                    images: [],
                    onActivity: () => Promise.resolve(),
                    onText: () => Promise.resolve(),
                    prompt: "second",
                    resources: [],
                    sessionId: "locked-conversation",
                    signal: new AbortController().signal,
                }),
            ).rejects.toThrow("agent or workspace cannot change");
        } finally {
            await manager.close();
        }
    });

    it("Given an ACP subprocess exits during shutdown, When its session manager closes, Then the stream failure is contained", async () => {
        const manager = new AcpSessionManager();
        const agent = new LocalAgentDefinition("codex", "Codex", process.execPath, [
            fakeAgentPath,
            "--exit-after-session-creation",
        ]);
        const signal = new AbortController().signal;

        await manager.prepareSession({
            additionalDirectories: [],
            agent,
            cwd: process.cwd(),
            sessionId: "exited-conversation",
            signal,
        });
        await expect(
            manager.configureSession({
                additionalDirectories: [],
                agent,
                booleanValue: false,
                configId: "model",
                cwd: process.cwd(),
                requestId: "configure-exited-session",
                sessionId: "exited-conversation",
                signal,
                value: "test-large",
                valueType: "select",
            }),
        ).rejects.toThrow();

        await expect(manager.close()).resolves.toBeUndefined();
    });

    it("Given an ACP process pipe fails, When the protocol writes to it, Then the stream reports the failure without an uncaught process error", async () => {
        const output = new Writable({
            write(_chunk, _encoding, callback) {
                callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
            },
        });
        const writer = createWritableAcpStream(output).getWriter();

        await expect(writer.write(new Uint8Array([1]))).rejects.toThrow("broken pipe");
    });
});
