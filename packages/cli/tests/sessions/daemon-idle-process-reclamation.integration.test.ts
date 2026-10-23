import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    decodeMessageKind,
    decodeSessionCloseNoticeEvent,
    decodeSessionEvent,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    decodeSessionsQueriedEvent,
    encodeNativeSessionCommand,
    encodeSessionCloseCommand,
    encodeSessionConfigReadCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeSessionQueryCommand,
    encodeSessionRenameCommand,
    encodeSessionRestoreCommand,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { afterEach, expect, test, vi } from "vitest";
import {
    DirectAcpAgentSpecification,
    InProcessAcpAgentSpecification,
} from "../../src/agent/specification/agent-specification.ts";
import { ControlledSessionAgent } from "../support/agents/controlled-session-agent.ts";
import { waitForAgentFile } from "../support/agents/observed-process.ts";
import { prepareNewRealSession, type RealDaemonPeer, withRealDaemon } from "../support/agents/real-daemon.ts";
import { IdleTimeoutTimer } from "../support/idle-timeout-timer.ts";

class IdleAgentSpecification extends DirectAcpAgentSpecification {
    readonly adapterVersion = "1.0.0";
    readonly agentExecutable = "controlled-acp";
    readonly id = "claude";
    readonly label = "Controlled ACP";
    override readonly minimumSupportedAgentVersion = "1.0.0";
    override readonly maximumTestedAgentVersion = "1.0.0";

    constructor() {
        super("MOBIUS_TEST_CONTROLLED_ACP_PATH", []);
    }
}

const twoHours = 2 * 60 * 60 * 1_000;
const peerUrl = new URL("./fixtures/acp-peer.ts", import.meta.url).href;

// Failure modes: no reclamation below capacity; early reclamation; old deadlines surviving
// activity; busy turns/history being interrupted; native identity/history being lost;
// query processes leaking; old close/shutdown deadlines affecting replacement processes.
// All scenarios enter through the public daemon protocol and observe real subprocess files.

afterEach(() => vi.useRealTimers());

async function withIdleDaemon(
    recovery: "resume" | "load",
    scenario: (peer: RealDaemonPeer, native: string, timer: IdleTimeoutTimer) => Promise<void>,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "mobius-idle-process-"));
    const native = join(directory, "native");
    const executable = join(directory, "controlled-acp");
    await mkdir(native);
    await writeFile(
        executable,
        `#!${process.execPath}
if (process.argv.includes("--version")) {
    process.stdout.write("1.0.0\\n");
} else {
    process.env.MOBIUS_FAKE_ACP_PROCESS_ID = String(process.pid);
    process.argv.push("--agent-name", "Controlled ACP", "--exclusive-writer", "--http-mcp",
        "--no-additional-directories", "--no-delete-session", "--no-fork-session", "--no-embedded-context"
        ${recovery === "load" ? ', "--load-only"' : ""});
    await import(${JSON.stringify(peerUrl)});
}
`,
        { mode: 0o700 },
    );
    vi.useFakeTimers({ now: new Date("2026-10-22T00:00:00Z"), toFake: ["Date"] });
    try {
        const timer = new IdleTimeoutTimer();
        await withRealDaemon(
            new IdleAgentSpecification(),
            {
                MOBIUS_FAKE_ACP_STATE_DIRECTORY: native,
                MOBIUS_FAKE_ACP_PROCESS_DIRECTORY: native,
                MOBIUS_FAKE_ACP_FAIL_HISTORY_LOAD: "0",
                MOBIUS_TEST_CONTROLLED_ACP_PATH: executable,
            },
            async (peer) => await scenario(peer, native, timer),
            "embedded",
            undefined,
            timer,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function processId(native: string): Promise<string> {
    const writers = (await readdir(native)).filter((file) => file.endsWith(".writer"));
    expect(writers).toHaveLength(1);
    const writer = writers[0];
    if (writer === undefined) {
        throw new Error("The Agent has no native Session writer");
    }
    return await readFile(join(native, writer), "utf8");
}

async function expire(native: string, pid: string, timer: IdleTimeoutTimer): Promise<void> {
    const exit = waitForAgentFile(join(native, `${pid}.process`), false);
    timer.advance(1);
    await exit;
}

function sendPrompt(peer: RealDaemonPeer, sessionId: string, prompt: string): void {
    peer.send(
        encodeSessionPromptCommand({
            additionalDirectoryIds: [],
            agentId: "claude",
            bindingId: peer.bindingId,
            commandId: crypto.randomUUID(),
            directoryId: "default",
            disposition: SessionPromptDisposition.Reject,
            images: [],
            kind: "session.prompt",
            prompt,
            resources: [],
            sessionId,
            targetCommandId: "",
        }),
    );
}

async function readTurn(peer: RealDaemonPeer): Promise<string> {
    let text = "";
    for (;;) {
        const event = decodeSessionEvent(JSON.parse(await peer.nextEvent()));
        if (
            event.type === "acp" &&
            event.payload.sessionUpdate === "agent_message_chunk" &&
            event.payload.content.type === "text"
        ) {
            text += event.payload.content.text;
        }
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.failed") {
            throw new Error(JSON.stringify(event));
        }
        if (event.type === "lifecycle-metadata" && event.payload.kind === "prompt.completed") {
            expect(event.payload.stopReason).toBe("end_turn");
            return text;
        }
    }
}

async function prompt(peer: RealDaemonPeer, sessionId: string, text: string): Promise<string> {
    sendPrompt(peer, sessionId, text);
    return await readTurn(peer);
}

async function nextResponse(peer: RealDaemonPeer, kind: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        const received = decodeMessageKind(message);
        if (received === kind) {
            return message;
        }
        if (received === "session.close.notice") {
            // Idle reclamation announces the Session while the scenario keeps reading other replies.
            decodeSessionCloseNoticeEvent(message);
            continue;
        }
        if (received === "session.operation.failed") {
            throw new Error(message);
        }
    }
}

async function nextMessageOfKind(peer: RealDaemonPeer, kind: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        if (decodeMessageKind(message) === kind) {
            return message;
        }
    }
}

test.each(["resume", "load"] as const)(
    "Given a retained %s conversation below capacity, When it is idle for two hours, Then its process exits and the same native conversation continues",
    async (recovery) => {
        await withIdleDaemon(recovery, async (peer, native, timer) => {
            const sessionId = await prepareNewRealSession(peer, "claude");
            expect(await prompt(peer, sessionId, "Remember the first turn")).toContain("turn 1:");
            const original = await processId(native);
            timer.advance(twoHours - 1);
            expect(await processId(native)).toBe(original);
            const closed = nextResponse(peer, "session.close.notice");
            await expire(native, original, timer);
            expect(decodeSessionCloseNoticeEvent(await closed)).toEqual({
                kind: "session.close.notice",
                reason: "This Session was closed after two idle hours.",
                sessionId,
            });
            expect((await readdir(native)).filter((file) => file.endsWith(".writer"))).toEqual([]);
            expect(await prompt(peer, sessionId, "Continue after idle reclamation")).toContain("turn 2:");
            expect(await processId(native)).not.toBe(original);
            peer.send(
                encodeSessionHistoryPageLoad({
                    kind: "session.live-history.v2.page.load",
                    requestId: crypto.randomUUID(),
                    sessionId,
                    cursor: null,
                    eventLimit: 200,
                }),
            );
            const history = await nextResponse(peer, "session.live-history.v2.page.loaded");
            expect(history).toContain("Remember the first turn");
            expect(history).toContain("Continue after idle reclamation");
        });
    },
);

test("Given a retained conversation is used again, When its original idle deadline passes, Then it stays alive until two hours after the latest turn", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionId = await prepareNewRealSession(peer, "claude");
        await prompt(peer, sessionId, "First turn");
        const original = await processId(native);
        timer.advance(twoHours / 2);
        await prompt(peer, sessionId, "Refresh the idle deadline");
        timer.advance(twoHours - 1);
        expect(await processId(native)).toBe(original);
        await expire(native, original, timer);
    });
});

test("Given a turn lasts longer than the idle timeout, When three hours pass, Then it completes in the same process and receives a full idle window afterwards", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionId = await prepareNewRealSession(peer, "claude");
        const original = await processId(native);
        timer.advance(twoHours / 2);
        const paused = waitForAgentFile(join(native, "prompt-paused"), true);
        sendPrompt(peer, sessionId, "release before first delta");
        await paused;
        timer.advance(3 * 60 * 60 * 1_000);
        expect(await processId(native)).toBe(original);
        await writeFile(join(native, "resume-turn"), "");
        expect(await readTurn(peer)).toContain("turn 1:");
        timer.advance(twoHours - 1);
        expect(await processId(native)).toBe(original);
        await expire(native, original, timer);
    });
});

test("Given a retained native session browser, When two idle hours pass, Then its process exits and browsing can start again", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionId = await prepareNewRealSession(peer, "claude");
        await prompt(peer, sessionId, "Persist a listed conversation");
        const execution = await processId(native);
        const browse = async (): Promise<string> => {
            peer.send(
                encodeNativeSessionCommand({
                    kind: "native.session.request",
                    requestId: crypto.randomUUID(),
                    sessionId: "native-browser",
                    agentId: "claude",
                    bindingId: peer.bindingId,
                    directoryId: "default",
                    additionalDirectoryIds: [],
                    action: "list",
                    cursor: null,
                }),
            );
            return await nextResponse(peer, "native.session.result");
        };
        expect(await browse()).toContain(sessionId);
        const processes = (await readdir(native)).filter((file) => file.endsWith(".process"));
        expect(processes).toHaveLength(2);
        timer.advance(twoHours - 1);
        const exits = processes.map((file) => waitForAgentFile(join(native, file), false));
        timer.advance(1);
        await Promise.all(exits);
        expect(existsSync(join(native, `${execution}.process`))).toBe(false);
        expect(await browse()).toContain(sessionId);
    });
});

test("Given an old retained process was closed and the daemon restarted, When its deadline passes, Then a newly prepared process gets its own full idle window", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionId = await prepareNewRealSession(peer, "claude");
        await prompt(peer, sessionId, "Before close");
        timer.advance(twoHours / 2);
        peer.send(encodeSessionCloseCommand({ kind: "session.close", requestId: crypto.randomUUID(), sessionId }));
        for (;;) {
            if (decodeMessageKind(await peer.nextMessage()) === "session.closed") {
                break;
            }
        }
        await peer.restart();
        peer.send(
            encodeSessionPrepareCommand({
                kind: "session.prepare",
                requestId: crypto.randomUUID(),
                sessionId,
                agentId: "claude",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
            }),
        );
        expect(decodeSessionReadyEvent(await nextResponse(peer, "session.ready")).sessionId).toBe(sessionId);
        const replacement = await processId(native);
        timer.advance(twoHours - 1);
        expect(await processId(native)).toBe(replacement);
        await expire(native, replacement, timer);
    });
});

test("Given native history is loading in a retained process, When three hours pass, Then the load completes and a new idle window starts", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionId = await prepareNewRealSession(peer, "claude");
        await prompt(peer, sessionId, "History before a long load");
        peer.send(encodeSessionCloseCommand({ kind: "session.close", requestId: crypto.randomUUID(), sessionId }));
        for (;;) {
            if (decodeMessageKind(await peer.nextMessage()) === "session.closed") {
                break;
            }
        }
        peer.send(
            encodeSessionPrepareCommand({
                kind: "session.prepare",
                requestId: crypto.randomUUID(),
                sessionId,
                agentId: "claude",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
            }),
        );
        await nextResponse(peer, "session.ready");
        const original = await processId(native);
        await writeFile(join(native, "pause-load"), "*");
        const paused = waitForAgentFile(join(native, "load-paused"), true);
        peer.send(encodeSessionRestoreCommand({ kind: "session.restore", requestId: crypto.randomUUID(), sessionId }));
        const restored = nextResponse(peer, "session.restored");
        await Promise.race([
            paused,
            restored.then((response) => {
                throw new Error(`History completed before the controlled load was released: ${response}`);
            }),
        ]);
        timer.advance(3 * 60 * 60 * 1_000);
        expect(await processId(native)).toBe(original);
        await rm(join(native, "pause-load"));
        await restored;
        timer.advance(twoHours - 1);
        expect(await processId(native)).toBe(original);
        await expire(native, original, timer);
    });
});

test("Given a canonical native Session is idle, When its process is reclaimed, Then the daemon holds nothing until the conversation is recovered from the Agent", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionId = crypto.randomUUID();
        await writeFile(
            join(native, `${sessionId}.json`),
            JSON.stringify({
                turnCount: 1,
                model: "test-small",
                reasoningEffort: "medium",
                fastMode: false,
                mode: "code",
                cwd: peer.workspace,
                additionalDirectories: [],
                title: "Native title before idle",
                history: [],
            }),
        );
        peer.send(
            encodeSessionPrepareCommand({
                kind: "session.prepare",
                requestId: crypto.randomUUID(),
                sessionId,
                agentId: "claude",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
            }),
        );
        await nextResponse(peer, "session.ready");
        peer.send(
            encodeSessionRenameCommand({
                kind: "session.rename",
                requestId: crypto.randomUUID(),
                sessionId,
                title: "Native title before idle",
            }),
        );
        await nextResponse(peer, "session.renamed");
        const original = await processId(native);
        timer.advance(twoHours - 1);
        await expire(native, original, timer);
        // Like a daemon restart, idle reclamation leaves the stored Session behind nothing.
        peer.send(
            encodeSessionQueryCommand({
                kind: "session.query",
                requestId: crypto.randomUUID(),
                sessionIds: [sessionId],
            }),
        );
        expect(decodeSessionsQueriedEvent(await nextResponse(peer, "session.queried")).entries).toEqual([]);
        expect((await readdir(native)).filter((file) => file.endsWith(".process"))).toEqual([]);
        expect(await prompt(peer, sessionId, "Continue the canonical Session")).toContain("turn 2:");
    });
});

test("Given a canonical native Session was reclaimed while idle, When a client reads it without preparing first, Then each read reports session_not_prepared and a prompt recovers the conversation", async () => {
    await withIdleDaemon("resume", async (peer, native, timer) => {
        const sessionId = crypto.randomUUID();
        await writeFile(
            join(native, `${sessionId}.json`),
            JSON.stringify({
                turnCount: 1,
                model: "test-small",
                reasoningEffort: "medium",
                fastMode: false,
                mode: "code",
                cwd: peer.workspace,
                additionalDirectories: [],
                title: "Native title before idle",
                history: [],
            }),
        );
        peer.send(
            encodeSessionPrepareCommand({
                kind: "session.prepare",
                requestId: crypto.randomUUID(),
                sessionId,
                agentId: "claude",
                bindingId: peer.bindingId,
                directoryId: "default",
                additionalDirectoryIds: [],
            }),
        );
        await nextResponse(peer, "session.ready");
        const original = await processId(native);
        timer.advance(twoHours - 1);
        await expire(native, original, timer);

        const requestIds = {
            restore: crypto.randomUUID(),
            history: crypto.randomUUID(),
            config: crypto.randomUUID(),
            rename: crypto.randomUUID(),
        };
        peer.send(encodeSessionRestoreCommand({ kind: "session.restore", requestId: requestIds.restore, sessionId }));
        peer.send(
            encodeSessionHistoryPageLoad({
                kind: "session.live-history.v2.page.load",
                requestId: requestIds.history,
                sessionId,
                cursor: null,
                eventLimit: 200,
            }),
        );
        peer.send(
            encodeSessionConfigReadCommand({
                kind: "session.config.read",
                requestId: requestIds.config,
                sessionId,
            }),
        );
        peer.send(
            encodeSessionRenameCommand({
                kind: "session.rename",
                requestId: requestIds.rename,
                sessionId,
                title: "Renamed after idle",
            }),
        );
        for (let index = 0; index < Object.keys(requestIds).length; index += 1) {
            const failure = decodeSessionOperationFailedEvent(
                await nextMessageOfKind(peer, "session.operation.failed"),
            );
            expect(failure.code).toBe("session_not_prepared");
            expect(failure.sessionId).toBe(sessionId);
            expect(Object.values(requestIds)).toContain(failure.requestId);
        }
        expect((await readdir(native)).filter((file) => file.endsWith(".process"))).toEqual([]);
        expect(await prompt(peer, sessionId, "Continue after failed reads")).toContain("turn 2:");
        peer.send(
            encodeSessionHistoryPageLoad({
                kind: "session.live-history.v2.page.load",
                requestId: crypto.randomUUID(),
                sessionId,
                cursor: null,
                eventLimit: 200,
            }),
        );
        expect(await nextResponse(peer, "session.live-history.v2.page.loaded")).toContain(
            "Continue after failed reads",
        );
    });
});

class RetiringIdleAgentSpecification extends InProcessAcpAgentSpecification {
    readonly agentExecutable = "node";
    readonly id = "claude";
    readonly label = "Controlled retiring Agent";
    override readonly minimumSupportedAgentVersion = process.versions.node;
    override readonly maximumTestedAgentVersion = process.versions.node;
    readonly sessions = new ControlledSessionAgent();
    readonly createEndpoint = this.sessions.createEndpoint;

    constructor() {
        super("MOBIUS_TEST_RETIRING_IDLE_PATH");
    }
}

test("Given idle process teardown is still releasing the native writer, When a new prompt arrives, Then it waits before starting a replacement process", async () => {
    const specification = new RetiringIdleAgentSpecification();
    const timer = new IdleTimeoutTimer();
    vi.useFakeTimers({ now: new Date("2026-10-22T00:00:00Z"), toFake: ["Date"] });
    await withRealDaemon(
        specification,
        { MOBIUS_TEST_RETIRING_IDLE_PATH: process.execPath },
        async (peer) => {
            try {
                const sessionId = await prepareNewRealSession(peer, "claude");
                await prompt(peer, sessionId, "Before idle retirement");
                const held = specification.sessions.closes.hold();
                timer.advance(twoHours);
                await held.entered;
                sendPrompt(peer, sessionId, "After idle retirement");
                peer.send(
                    encodeSessionQueryCommand({
                        kind: "session.query",
                        requestId: crypto.randomUUID(),
                        sessionIds: [sessionId],
                    }),
                );
                await nextResponse(peer, "session.queried");
                // One discovery endpoint and one live process; a second writer must wait for teardown.
                expect(specification.sessions.endpointCount()).toBe(2);
                held.release();
                await readTurn(peer);
                expect(specification.sessions.endpointCount()).toBe(3);
            } finally {
                specification.sessions.releaseAll();
            }
        },
        "embedded",
        undefined,
        timer,
    );
});

test("Given idle teardown is still running, When a client closes the Session, Then the closed Session keeps its stored title for reopening", async () => {
    const specification = new RetiringIdleAgentSpecification();
    const timer = new IdleTimeoutTimer();
    vi.useFakeTimers({ now: new Date("2026-10-22T00:00:00Z"), toFake: ["Date"] });
    await withRealDaemon(
        specification,
        { MOBIUS_TEST_RETIRING_IDLE_PATH: process.execPath },
        async (peer) => {
            try {
                // A UUID Session id of a native chat Agent is canonical, so idle reclamation drops its row.
                const sessionId = crypto.randomUUID();
                peer.send(
                    encodeSessionPrepareCommand({
                        kind: "session.prepare",
                        requestId: crypto.randomUUID(),
                        sessionId,
                        agentId: "claude",
                        bindingId: peer.bindingId,
                        directoryId: "default",
                        additionalDirectoryIds: [],
                    }),
                );
                expect(decodeSessionReadyEvent(await nextResponse(peer, "session.ready")).sessionId).toBe(sessionId);
                await prompt(peer, sessionId, "Before the raced close");
                const held = specification.sessions.closes.hold();
                timer.advance(twoHours);
                await held.entered;
                // The explicit close arrives while the idle teardown still holds the process.
                peer.send(
                    encodeSessionCloseCommand({ kind: "session.close", requestId: crypto.randomUUID(), sessionId }),
                );
                const reasons: string[] = [];
                for (;;) {
                    const message = await peer.nextMessage();
                    if (decodeMessageKind(message) !== "session.close.notice") {
                        continue;
                    }
                    reasons.push(decodeSessionCloseNoticeEvent(message).reason);
                    if (reasons.length === 2) {
                        break;
                    }
                }
                // The idle announcement reaches every client first; the explicit close announces again.
                expect(reasons).toEqual([
                    "This Session was closed after two idle hours.",
                    "This Session was closed on request.",
                ]);
                held.release();
                await nextResponse(peer, "session.closed");
                peer.send(
                    encodeSessionQueryCommand({
                        kind: "session.query",
                        requestId: crypto.randomUUID(),
                        sessionIds: [sessionId],
                    }),
                );
                // The client asked for this Session to stay closed-and-reopenable, so its row survives
                // even though the idle path had already chosen to drop it.
                expect(decodeSessionsQueriedEvent(await nextResponse(peer, "session.queried")).entries).toEqual([
                    expect.objectContaining({ sessionId, title: "Before the raced close" }),
                ]);
            } finally {
                specification.sessions.releaseAll();
            }
        },
        "embedded",
        undefined,
        timer,
    );
});
