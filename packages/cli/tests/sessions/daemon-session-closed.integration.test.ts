import {
    decodeMessageKind,
    decodeSessionClosedEvent,
    decodeSessionCloseNoticeEvent,
    decodeSessionConfigReadResult,
    decodeSessionOperationFailedEvent,
    decodeSessionReadyEvent,
    decodeSessionRenamedEvent,
    decodeSessionStatusChangedEvent,
    decodeSessionsQueriedEvent,
    encodeSessionCloseCommand,
    encodeSessionConfigReadCommand,
    encodeSessionElicitationRespondCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeSessionQueryCommand,
    encodeSessionRenameCommand,
    SESSION_CLOSED_ERROR_CODE,
    type SessionOperationFailedEvent,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { expect, test } from "vitest";
import type { InProcessAcpEndpointFactory } from "../../src/acp/agent/in-process-endpoint.ts";
import { InProcessAcpAgentSpecification } from "../../src/agent/specification/agent-specification.ts";
import { ControlledSessionAgent } from "../support/agents/controlled-session-agent.ts";
import { type RealDaemonPeer, withControlledDaemon as withRealDaemon } from "../support/agents/real-daemon.ts";

// A native chat Agent id makes a UUID Session id the Agent's own Session id, which is how the daemon runs
// Claude, Codex and Pi conversations.
const NATIVE_AGENT_ID = "claude";

/** Endpoint 0 serves discovery; each Agent process the daemon starts later gets the next index. */
class ClosableAgentSpecification extends InProcessAcpAgentSpecification {
    readonly agentExecutable = "node";
    readonly id = NATIVE_AGENT_ID;
    readonly label = "Controlled Claude";
    override readonly maximumTestedAgentVersion = process.versions.node;
    override readonly minimumSupportedAgentVersion = process.versions.node;
    readonly sessions = new ControlledSessionAgent();
    readonly createEndpoint: InProcessAcpEndpointFactory = this.sessions.createEndpoint;

    constructor() {
        super("MOBIUS_TEST_CONTROLLED_CLOSABLE_PATH");
    }
}

async function withClosableDaemon(
    specification: ClosableAgentSpecification,
    scenario: (peer: RealDaemonPeer) => Promise<void>,
): Promise<void> {
    await withRealDaemon(specification, { MOBIUS_TEST_CONTROLLED_CLOSABLE_PATH: process.execPath }, async (peer) => {
        try {
            await scenario(peer);
        } finally {
            // A scenario that fails while a teardown is held must not keep the daemon from stopping.
            specification.sessions.releaseAll();
        }
    });
}

/** The next message of `kind`; unrelated traffic such as status changes is skipped. */
async function nextMessageOfKind(peer: RealDaemonPeer, kind: string): Promise<string> {
    for (;;) {
        const message = await peer.nextMessage();
        const received = decodeMessageKind(message);
        if (received === kind) {
            return message;
        }
        if (received === "session.operation.failed") {
            throw new Error(message);
        }
    }
}

/** The failure that answers `requestId`, which is a command id when a prompt was sent. */
async function nextFailure(peer: RealDaemonPeer, requestId: string): Promise<SessionOperationFailedEvent> {
    for (;;) {
        const message = await peer.nextMessage();
        const kind = decodeMessageKind(message);
        if (kind === "session.status.changed") {
            const { status } = decodeSessionStatusChangedEvent(message);
            if (status.kind === "working" && status.commandId === requestId) {
                throw new Error("The prompt started instead of failing");
            }
        }
        if (kind === "session.renamed" && decodeSessionRenamedEvent(message).requestId === requestId) {
            throw new Error("The rename succeeded instead of failing");
        }
        if (kind === "session.config.read.result" && decodeSessionConfigReadResult(message).requestId === requestId) {
            throw new Error("The settings read succeeded instead of failing");
        }
        if (kind !== "session.operation.failed") {
            continue;
        }
        const failure = decodeSessionOperationFailedEvent(message);
        if (failure.requestId === requestId) {
            return failure;
        }
    }
}

async function prepare(peer: RealDaemonPeer, sessionId: string): Promise<void> {
    const requestId = crypto.randomUUID();
    peer.send(
        encodeSessionPrepareCommand({
            additionalDirectoryIds: [],
            agentId: NATIVE_AGENT_ID,
            bindingId: peer.bindingId,
            directoryId: "default",
            kind: "session.prepare",
            requestId,
            sessionId,
        }),
    );
    expect(decodeSessionReadyEvent(await nextMessageOfKind(peer, "session.ready")).requestId).toBe(requestId);
}

function sendPrompt(peer: RealDaemonPeer, sessionId: string, prompt: string): string {
    const commandId = crypto.randomUUID();
    peer.send(
        encodeSessionPromptCommand({
            additionalDirectoryIds: [],
            agentId: NATIVE_AGENT_ID,
            bindingId: peer.bindingId,
            commandId,
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
    return commandId;
}

async function prompt(peer: RealDaemonPeer, sessionId: string, text: string): Promise<void> {
    sendPrompt(peer, sessionId, text);
    for (;;) {
        const message = await nextMessageOfKind(peer, "session.status.changed");
        const event = decodeSessionStatusChangedEvent(message);
        if (event.sessionId === sessionId && event.status.kind === "idle") {
            return;
        }
    }
}

function sendClose(peer: RealDaemonPeer, sessionId: string): string {
    const requestId = crypto.randomUUID();
    peer.send(encodeSessionCloseCommand({ kind: "session.close", requestId, sessionId }));
    return requestId;
}

/** Prepares a Session, runs one prompt in it, and closes it; the reply to the close has been received. */
async function closedSession(peer: RealDaemonPeer, title: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    await prepare(peer, sessionId);
    await prompt(peer, sessionId, title);
    const requestId = sendClose(peer, sessionId);
    expect(decodeSessionClosedEvent(await nextMessageOfKind(peer, "session.closed")).requestId).toBe(requestId);
    return sessionId;
}

test("Given a client closes a Session, When the Runtime stops its Agent process, Then the Runtime announces the closed Session and why before it answers the close request", async () => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(specification, async (peer) => {
        const sessionId = crypto.randomUUID();
        await prepare(peer, sessionId);
        const requestId = sendClose(peer, sessionId);

        const announcements: string[] = [];
        for (;;) {
            const message = await peer.nextMessage();
            const kind = decodeMessageKind(message);
            if (kind === "session.close.notice") {
                expect(decodeSessionCloseNoticeEvent(message)).toEqual({
                    kind,
                    reason: "This Session was closed on request.",
                    sessionId,
                });
                announcements.push(kind);
            }
            if (kind === "session.closed") {
                expect(decodeSessionClosedEvent(message)).toEqual({ kind, requestId, sessionId });
                announcements.push(kind);
                break;
            }
        }

        expect(announcements).toEqual(["session.close.notice", "session.closed"]);
        expect(specification.sessions.operations.at(-1)).toEqual({ endpoint: 1, method: "session/close", sessionId });
    });
});

test("Given a closed Session, When a client loads more history, Then the Runtime reports session_closed and starts no Agent process", async () => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(specification, async (peer) => {
        const sessionId = await closedSession(peer, "Plan the release");

        const requestId = crypto.randomUUID();
        peer.send(
            encodeSessionHistoryPageLoad({
                cursor: null,
                eventLimit: 200,
                kind: "session.live-history.v2.page.load",
                requestId,
                sessionId,
            }),
        );

        expect(await nextFailure(peer, requestId)).toMatchObject({ code: SESSION_CLOSED_ERROR_CODE, sessionId });
        expect(specification.sessions.endpointCount()).toBe(2);
    });
});

test("Given a closed Session, When a client sends a prompt, Then the Runtime reports session_closed and starts no Agent process", async () => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(specification, async (peer) => {
        const sessionId = await closedSession(peer, "Plan the release");

        const commandId = sendPrompt(peer, sessionId, "Continue the plan");

        expect(await nextFailure(peer, commandId)).toMatchObject({ code: SESSION_CLOSED_ERROR_CODE, sessionId });
        expect(specification.sessions.endpointCount()).toBe(2);
    });
});

test("Given a closed Session, When a client renames it, Then the Runtime reports session_closed", async () => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(specification, async (peer) => {
        const sessionId = await closedSession(peer, "Plan the release");

        const requestId = crypto.randomUUID();
        peer.send(encodeSessionRenameCommand({ kind: "session.rename", requestId, sessionId, title: "Release plan" }));

        expect(await nextFailure(peer, requestId)).toMatchObject({ code: SESSION_CLOSED_ERROR_CODE, sessionId });
    });
});

test("Given a closed Session, When a client reads its settings, Then the Runtime reports session_closed and starts no Agent process", async () => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(specification, async (peer) => {
        const sessionId = await closedSession(peer, "Plan the release");

        const requestId = crypto.randomUUID();
        peer.send(encodeSessionConfigReadCommand({ kind: "session.config.read", requestId, sessionId }));

        expect(await nextFailure(peer, requestId)).toMatchObject({ code: SESSION_CLOSED_ERROR_CODE, sessionId });
        expect(specification.sessions.endpointCount()).toBe(2);
    });
});

test("Given a closed Session, When a client answers a permission request or an elicitation, Then the Runtime reports session_closed for each", async () => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(specification, async (peer) => {
        const sessionId = await closedSession(peer, "Plan the release");

        const permissionId = crypto.randomUUID();
        peer.send(
            encodeSessionPermissionRespondCommand({
                interactionId: permissionId,
                kind: "session.permission.respond",
                optionId: "allow",
                outcome: "selected",
                sessionId,
            }),
        );
        expect(await nextFailure(peer, permissionId)).toMatchObject({ code: SESSION_CLOSED_ERROR_CODE, sessionId });

        const elicitationId = crypto.randomUUID();
        peer.send(
            encodeSessionElicitationRespondCommand({
                action: "accept",
                content: "{}",
                interactionId: elicitationId,
                kind: "session.elicitation.respond",
                sessionId,
            }),
        );
        expect(await nextFailure(peer, elicitationId)).toMatchObject({ code: SESSION_CLOSED_ERROR_CODE, sessionId });
    });
});

test("Given a Session whose Agent process is still stopping, When a client sends a prompt, Then the Runtime reports session_closed without waiting for the process", async () => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(specification, async (peer) => {
        const sessionId = crypto.randomUUID();
        await prepare(peer, sessionId);
        const teardown = specification.sessions.closes.hold();
        sendClose(peer, sessionId);
        await teardown.entered;

        const commandId = sendPrompt(peer, sessionId, "Too late");

        expect(await nextFailure(peer, commandId)).toMatchObject({ code: SESSION_CLOSED_ERROR_CODE, sessionId });
        expect(specification.sessions.endpointCount()).toBe(2);
        teardown.release();
        await nextMessageOfKind(peer, "session.closed");
    });
});

test("Given a closed Session, When a client prepares it again, Then the Runtime resumes the Agent session and the next prompt runs", async () => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(specification, async (peer) => {
        const sessionId = await closedSession(peer, "Plan the release");

        await prepare(peer, sessionId);
        await prompt(peer, sessionId, "Continue the plan");

        expect(specification.sessions.operations).toEqual([
            { endpoint: 1, method: "session/resume", sessionId },
            { endpoint: 1, method: "session/prompt", sessionId },
            { endpoint: 1, method: "session/close", sessionId },
            { endpoint: 2, method: "session/resume", sessionId },
            { endpoint: 2, method: "session/prompt", sessionId },
        ]);
    });
});

test("Given a Session that its first prompt titled, When a client closes it, Then the Runtime still stores the Session with its title", async () => {
    const specification = new ClosableAgentSpecification();
    await withClosableDaemon(specification, async (peer) => {
        const sessionId = await closedSession(peer, "Plan the release");

        const requestId = crypto.randomUUID();
        peer.send(encodeSessionQueryCommand({ kind: "session.query", requestId, sessionIds: [sessionId] }));

        const queried = decodeSessionsQueriedEvent(await nextMessageOfKind(peer, "session.queried"));
        expect(queried.entries).toEqual([
            expect.objectContaining({ prompted: true, sessionId, title: "Plan the release" }),
        ]);
    });
});
