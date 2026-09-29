import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionElicitationRequestedEvent,
    decodeSessionEventEnvelope,
    decodeSessionPermissionRequestedEvent,
    decodeSessionsQueriedEvent,
    encodeNativeSessionRequest,
    encodeSessionElicitationRespondCommand,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeSessionQueryCommand,
    MOBIUS_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_COMPLETED_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_EVENT_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    SESSION_QUERIED_KIND,
    SESSION_READY_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { LocalAgentDefinition } from "../../../packages/cli/src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../../packages/cli/src/audit/audit-store.ts";
import { createDaemonConfig, DaemonLocalContext } from "../../../packages/cli/src/config.ts";
import { runDaemon } from "../../../packages/cli/src/run-daemon.ts";
import { listen, port } from "../../../tests/infra/websocket.ts";

class Messages {
    readonly #buffered: string[] = [];
    readonly #waiting: Array<(message: string) => void> = [];

    constructor(socket: WebSocket) {
        socket.on("message", (value) => {
            const message = value.toString();
            const resolve = this.#waiting.shift();
            if (resolve === undefined) {
                this.#buffered.push(message);
            } else {
                resolve(message);
            }
        });
    }

    readonly nextKind = async (kind: string): Promise<string> => {
        for (;;) {
            const raw = this.#buffered.shift() ?? (await new Promise<string>((resolve) => this.#waiting.push(resolve)));
            const message =
                decodeMessageKind(raw) === SESSION_EVENT_KIND ? decodeSessionEventEnvelope(raw).payload : raw;
            if (decodeMessageKind(message) === kind) {
                return message;
            }
        }
    };
}

test("Given an Agent was inspected transiently, When its first Turn materializes and resolves interactions, Then readiness is recorded and resolved interactions do not appear in its snapshot", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-interaction-snapshot-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MOBIUS_API_PREFIX}/channels/interaction/daemon`,
    );
    relayUrl.searchParams.set("token", "r".repeat(43));
    const fakeAgentPath = fileURLToPath(new URL("../fixtures/fake-acp-agent/src/cli.ts", import.meta.url));
    const agent = new LocalAgentDefinition(
        "claude",
        "Claude Code",
        process.execPath,
        [fakeAgentPath, "--agent-name", "Claude Code"],
        {
            MOBIUS_FAKE_ACP_PAUSE_AFTER_PERMISSION: "1",
            MOBIUS_FAKE_ACP_PAUSE_AFTER_ELICITATION: "1",
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "agent"),
        },
    );
    const config = createDaemonConfig(
        { channelId: "interaction", defaultWorkspace: workspace, relayUrl },
        [agent],
        [],
        new DaemonLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const audit = new AuditStore();
    const daemon = runDaemon(config, audit, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
        const sessionId = "interaction_snapshot";
        socket.send(
            encodeSessionPrepareCommand({
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: config.bindingId,
                directoryId: "default",
                kind: "session.prepare",
                requestId: "inspect_request",
                sessionId,
                transient: true,
            }),
        );
        await messages.nextKind(SESSION_READY_KIND);
        socket.send(
            encodeSessionPromptCommand({
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: config.bindingId,
                commandId: "interaction_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "exercise ACP controls",
                resources: [],
                sessionId,
                targetCommandId: "",
            }),
        );
        await messages.nextKind(SESSION_READY_KIND);
        const snapshot = async (requestId: string) => {
            socket.send(
                encodeNativeSessionRequest({
                    action: "active-turn",
                    additionalDirectoryIds: [],
                    agentId: "claude",
                    bindingId: config.bindingId,
                    directoryId: "default",
                    kind: "native.session.request",
                    requestId,
                    sessionId,
                    targetSessionId: sessionId,
                }),
            );
            return decodeNativeSessionResult(await messages.nextKind(NATIVE_SESSION_RESULT_KIND));
        };
        const permission = decodeSessionPermissionRequestedEvent(
            await messages.nextKind(SESSION_PERMISSION_REQUESTED_KIND),
        );
        expect(await snapshot("permission_snapshot")).toMatchObject({
            action: "active-turn",
            turn: { interaction: permission },
        });
        socket.send(
            encodeSessionPermissionRespondCommand({
                interactionId: permission.interactionId,
                kind: "session.permission.respond",
                optionId: "allow-once",
                outcome: "selected",
                sessionId,
            }),
        );
        await messages.nextKind(SESSION_PERMISSION_RESOLVED_KIND);
        expect(await snapshot("resolved_permission_snapshot")).toMatchObject({
            action: "active-turn",
            turn: { interaction: null },
        });
        await writeFile(join(stateDirectory, "agent", "resume-after-permission"), "");
        const elicitation = decodeSessionElicitationRequestedEvent(
            await messages.nextKind(SESSION_ELICITATION_REQUESTED_KIND),
        );
        expect(await snapshot("elicitation_snapshot")).toMatchObject({
            action: "active-turn",
            turn: { interaction: elicitation },
        });
        socket.send(
            encodeSessionElicitationRespondCommand({
                action: "accept",
                content: JSON.stringify({ branch: "main" }),
                interactionId: elicitation.interactionId,
                kind: "session.elicitation.respond",
                sessionId,
            }),
        );
        await messages.nextKind(SESSION_ELICITATION_RESOLVED_KIND);
        expect(await snapshot("resolved_elicitation_snapshot")).toMatchObject({
            action: "active-turn",
            turn: { interaction: null },
        });
        await writeFile(join(stateDirectory, "agent", "resume-after-elicitation"), "");
        await messages.nextKind(SESSION_COMPLETED_KIND);
    } finally {
        cancellation.abort();
        await daemon;
        audit.close();
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given a real daemon prepared a Session, When Platform queries its metadata, Then the daemon returns it without closing the Runtime", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-session-query-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MOBIUS_API_PREFIX}/channels/session-query/daemon`,
    );
    relayUrl.searchParams.set("token", "r".repeat(43));
    const fakeAgentPath = fileURLToPath(new URL("../fixtures/fake-acp-agent/src/cli.ts", import.meta.url));
    const agent = new LocalAgentDefinition("codex", "Codex", process.execPath, [
        fakeAgentPath,
        "--agent-name",
        "Codex",
    ]);
    const config = createDaemonConfig(
        { channelId: "session-query", defaultWorkspace: workspace, relayUrl },
        [agent],
        [],
        new DaemonLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const audit = new AuditStore();
    const daemon = runDaemon(config, audit, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
        const sessionId = "prepared_session";
        socket.send(
            encodeSessionPrepareCommand({
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: config.bindingId,
                directoryId: "default",
                kind: "session.prepare",
                requestId: "prepare_request",
                sessionId,
            }),
        );
        await messages.nextKind(SESSION_READY_KIND);

        socket.send(
            encodeSessionQueryCommand({
                kind: "session.query",
                requestId: "query_request",
                sessionIds: [sessionId],
            }),
        );

        expect(decodeSessionsQueriedEvent(await messages.nextKind(SESSION_QUERIED_KIND))).toMatchObject({
            entries: [
                {
                    agentId: "codex",
                    prompted: false,
                    sessionId,
                    title: "Untitled session",
                },
            ],
            requestId: "query_request",
        });
    } finally {
        cancellation.abort();
        await daemon;
        audit.close();
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);
