import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    decodeMessageKind,
    decodeNativeSessionResult,
    decodeSessionElicitationRequestedEvent,
    decodeSessionEventEnvelope,
    decodeSessionHistoryPageLoaded,
    decodeSessionInfoUpdatedEvent,
    decodeSessionPermissionRequestedEvent,
    decodeSessionRestoredEvent,
    decodeSessionStatusChangedEvent,
    decodeSessionsQueriedEvent,
    encodeNativeSessionRequest,
    encodeSessionElicitationRespondCommand,
    encodeSessionHistoryPageLoad,
    encodeSessionPermissionRespondCommand,
    encodeSessionPrepareCommand,
    encodeSessionPromptCommand,
    encodeSessionQueryCommand,
    encodeSessionRestoreCommand,
    MOBIUS_API_PREFIX,
    NATIVE_SESSION_RESULT_KIND,
    SESSION_ELICITATION_REQUESTED_KIND,
    SESSION_ELICITATION_RESOLVED_KIND,
    SESSION_EVENT_KIND,
    SESSION_INFO_UPDATED_KIND,
    SESSION_PERMISSION_REQUESTED_KIND,
    SESSION_PERMISSION_RESOLVED_KIND,
    SESSION_QUERIED_KIND,
    SESSION_READY_KIND,
    SESSION_RESTORED_KIND,
    SESSION_STATUS_CHANGED_KIND,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-sdk/protocol";
import { listen, port } from "@moxt-ai/mobius-test/websocket";
import { expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { LocalAgentDefinition } from "../../src/acp/agent/agent-definition.ts";
import { RuntimeLocalContext } from "../../src/runtime/config.ts";
import { runRuntime } from "../../src/runtime/run.ts";
import { createControlledRuntimeConfig as createRuntimeConfig } from "../support/controlled-runtime-config.ts";

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
            const message = raw;
            if (decodeMessageKind(raw) === SESSION_EVENT_KIND) {
                const events = decodeSessionEventEnvelope(raw).events.filter(
                    (event) => event.type === "lifecycle-metadata",
                );
                const matching = events.find(
                    (event) =>
                        "event" in event.payload && decodeMessageKind(JSON.stringify(event.payload.event)) === kind,
                );
                if (matching !== undefined && "event" in matching.payload) {
                    return JSON.stringify(matching.payload.event);
                }
                if (events.some((event) => event.payload.kind === kind)) {
                    return raw;
                }
                continue;
            }
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
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
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
    const config = createRuntimeConfig(
        { channelId: "interaction", defaultWorkspace: workspace, relayUrl },
        [agent],
        new RuntimeLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
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
        expect(decodeSessionStatusChangedEvent(await messages.nextKind(SESSION_STATUS_CHANGED_KIND))).toEqual({
            kind: SESSION_STATUS_CHANGED_KIND,
            sessionId,
            status: { commandId: "interaction_turn", kind: "working" },
        });
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
        for (;;) {
            const information = decodeSessionInfoUpdatedEvent(await messages.nextKind(SESSION_INFO_UPDATED_KIND));
            if (information.updatedAt === "2026-09-04T00:01:00.000Z") {
                expect(information).toEqual({
                    kind: SESSION_INFO_UPDATED_KIND,
                    sessionId,
                    title: "ACP feature session",
                    updatedAt: "2026-09-04T00:01:00.000Z",
                });
                break;
            }
        }
        const permission = decodeSessionPermissionRequestedEvent(
            await messages.nextKind(SESSION_PERMISSION_REQUESTED_KIND),
        );
        expect(permission).toMatchObject({
            details: {
                cwd: await realpath(workspace),
                rawInput: { command: "pnpm test -- --reporter=verbose", target: "src/<entry>.ts" },
                locations: [{ path: "src/<entry>.ts", line: 12 }],
            },
        });
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
        expect(decodeSessionStatusChangedEvent(await messages.nextKind(SESSION_STATUS_CHANGED_KIND))).toEqual({
            kind: SESSION_STATUS_CHANGED_KIND,
            sessionId,
            status: { kind: "idle" },
        });
        await messages.nextKind("prompt.completed");
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given an Agent announced a tool call with its input, When it requests permission referencing only that tool call, Then the permission carries the announced input, locations and kind", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-announced-permission-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MOBIUS_API_PREFIX}/channels/announced-permission/daemon`,
    );
    relayUrl.searchParams.set("token", "r".repeat(43));
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = new LocalAgentDefinition("claude", "Claude Code", process.execPath, [
        fakeAgentPath,
        "--agent-name",
        "Claude Code",
    ]);
    const config = createRuntimeConfig(
        { channelId: "announced-permission", defaultWorkspace: workspace, relayUrl },
        [agent],
        new RuntimeLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
        const sessionId = "announced_permission";
        socket.send(
            encodeSessionPrepareCommand({
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: config.bindingId,
                directoryId: "default",
                kind: "session.prepare",
                requestId: "prepare_request",
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
                commandId: "announced_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "request permission for an announced tool call",
                resources: [],
                sessionId,
                targetCommandId: "",
            }),
        );
        const permission = decodeSessionPermissionRequestedEvent(
            await messages.nextKind(SESSION_PERMISSION_REQUESTED_KIND),
        );
        expect(permission).toMatchObject({
            details: {
                cwd: await realpath(workspace),
                rawInput: { command: "sh scripts/release.sh --publish" },
                locations: [{ path: "scripts/release.sh", line: 3 }],
            },
            title: "Approve the release command",
            toolCallId: "announced-tool",
            toolKind: "execute",
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
        // The Agent finishes the Turn only after it receives the permission response.
        expect(decodeSessionStatusChangedEvent(await messages.nextKind(SESSION_STATUS_CHANGED_KIND))).toEqual({
            kind: SESSION_STATUS_CHANGED_KIND,
            sessionId,
            status: { kind: "idle" },
        });
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given an Agent announced a tool call and then sent a rawInput null update, When it requests permission referencing only that tool call, Then the permission keeps the announced input", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-null-input-permission-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MOBIUS_API_PREFIX}/channels/null-input-permission/daemon`,
    );
    relayUrl.searchParams.set("token", "r".repeat(43));
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = new LocalAgentDefinition("claude", "Claude Code", process.execPath, [
        fakeAgentPath,
        "--agent-name",
        "Claude Code",
    ]);
    const config = createRuntimeConfig(
        { channelId: "null-input-permission", defaultWorkspace: workspace, relayUrl },
        [agent],
        new RuntimeLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
        const sessionId = "null_input_permission";
        socket.send(
            encodeSessionPrepareCommand({
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: config.bindingId,
                directoryId: "default",
                kind: "session.prepare",
                requestId: "prepare_request",
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
                commandId: "null_input_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "request permission after a null rawInput update",
                resources: [],
                sessionId,
                targetCommandId: "",
            }),
        );
        const permission = decodeSessionPermissionRequestedEvent(
            await messages.nextKind(SESSION_PERMISSION_REQUESTED_KIND),
        );
        expect(permission).toMatchObject({
            details: {
                cwd: await realpath(workspace),
                rawInput: { command: "sh scripts/release.sh --publish" },
                locations: [{ path: "scripts/release.sh", line: 3 }],
            },
            title: "Approve the release command",
            toolCallId: "null-input-tool",
            toolKind: "execute",
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
        // The Agent finishes the Turn only after it receives the permission response.
        expect(decodeSessionStatusChangedEvent(await messages.nextKind(SESSION_STATUS_CHANGED_KIND))).toEqual({
            kind: SESSION_STATUS_CHANGED_KIND,
            sessionId,
            status: { kind: "idle" },
        });
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given an Agent's first recorded form of a tool call is an update, When it requests permission referencing only that tool call, Then the permission carries the update's input, locations and kind", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-orphan-update-permission-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MOBIUS_API_PREFIX}/channels/orphan-update-permission/daemon`,
    );
    relayUrl.searchParams.set("token", "r".repeat(43));
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = new LocalAgentDefinition("claude", "Claude Code", process.execPath, [
        fakeAgentPath,
        "--agent-name",
        "Claude Code",
    ]);
    const config = createRuntimeConfig(
        { channelId: "orphan-update-permission", defaultWorkspace: workspace, relayUrl },
        [agent],
        new RuntimeLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
        const sessionId = "orphan_update_permission";
        socket.send(
            encodeSessionPrepareCommand({
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: config.bindingId,
                directoryId: "default",
                kind: "session.prepare",
                requestId: "prepare_request",
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
                commandId: "orphan_update_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Reject,
                images: [],
                kind: "session.prompt",
                prompt: "request permission for an orphan update announcement",
                resources: [],
                sessionId,
                targetCommandId: "",
            }),
        );
        const permission = decodeSessionPermissionRequestedEvent(
            await messages.nextKind(SESSION_PERMISSION_REQUESTED_KIND),
        );
        expect(permission).toMatchObject({
            details: {
                cwd: await realpath(workspace),
                rawInput: { url: "https://example.test/permissions" },
                locations: [{ path: "docs/permissions.md", line: 7 }],
            },
            title: "Approve the fetch",
            toolCallId: "orphan-update-tool",
            toolKind: "fetch",
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
        // The Agent finishes the Turn only after it receives the permission response.
        expect(decodeSessionStatusChangedEvent(await messages.nextKind(SESSION_STATUS_CHANGED_KIND))).toEqual({
            kind: SESSION_STATUS_CHANGED_KIND,
            sessionId,
            status: { kind: "idle" },
        });
    } finally {
        cancellation.abort();
        await runtime;
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
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = new LocalAgentDefinition("codex", "Codex", process.execPath, [
        fakeAgentPath,
        "--agent-name",
        "Codex",
    ]);
    const config = createRuntimeConfig(
        { channelId: "session-query", defaultWorkspace: workspace, relayUrl },
        [agent],
        new RuntimeLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
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
                    status: { kind: "idle" },
                    title: "Untitled session",
                },
            ],
            requestId: "query_request",
        });
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given a real daemon persisted a Session, When Platform restores it by identifier, Then history is loaded once and remains available for paging", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-session-restore-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MOBIUS_API_PREFIX}/channels/session-restore/daemon`,
    );
    relayUrl.searchParams.set("token", "r".repeat(43));
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = new LocalAgentDefinition(
        "codex",
        "Codex",
        process.execPath,
        [fakeAgentPath, "--agent-name", "Codex", "--replay-history-once"],
        { MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "agent") },
    );
    const config = createRuntimeConfig(
        { channelId: "session-restore", defaultWorkspace: workspace, relayUrl },
        [agent],
        new RuntimeLocalContext(stateDirectory),
    );
    const startDaemon = async () => {
        const connected = Promise.withResolvers<WebSocket>();
        websocketServer.once("connection", (socket) => connected.resolve(socket));
        const cancellation = new AbortController();
        const completion = runRuntime(config, cancellation.signal);
        return { cancellation, completion, socket: await connected.promise };
    };
    try {
        const sessionId = "restored_session";
        const initial = await startDaemon();
        try {
            const messages = new Messages(initial.socket);
            initial.socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
            initial.socket.send(
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
            initial.socket.send(
                encodeSessionPromptCommand({
                    additionalDirectoryIds: [],
                    agentId: "codex",
                    bindingId: config.bindingId,
                    commandId: "initial_turn",
                    directoryId: "default",
                    disposition: SessionPromptDisposition.Reject,
                    images: [],
                    kind: "session.prompt",
                    prompt: "Persist this Session",
                    resources: [],
                    sessionId,
                    targetCommandId: "",
                }),
            );
            await messages.nextKind("prompt.completed");
        } finally {
            initial.cancellation.abort();
            await initial.completion;
        }

        const restored = await startDaemon();
        try {
            const messages = new Messages(restored.socket);
            restored.socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
            restored.socket.send(
                encodeSessionRestoreCommand({
                    kind: "session.restore",
                    requestId: "restore_request",
                    sessionId,
                }),
            );

            const restoredEvent = decodeSessionRestoredEvent(await messages.nextKind(SESSION_RESTORED_KIND));
            expect(restoredEvent).toMatchObject({
                entry: {
                    agentId: "codex",
                    prompted: true,
                    sessionId,
                    status: { kind: "idle" },
                    title: "Persist this Session",
                },
                kind: SESSION_RESTORED_KIND,
                ready: {
                    agentId: "codex",
                    kind: SESSION_READY_KIND,
                    requestId: "restore_request",
                    restored: true,
                    sessionId,
                },
                requestId: "restore_request",
            });
            expect(restoredEvent.ready.runtimeTimings?.map((timing) => timing.name)).toContain("session-load");
            expect(restoredEvent.ready.runtimeTimings?.map((timing) => timing.name)).not.toContain("session-resume");

            restored.socket.send(
                encodeSessionHistoryPageLoad({
                    cursor: null,
                    eventLimit: 200,
                    kind: "session.live-history.v2.page.load",
                    requestId: "history_request",
                    sessionId,
                }),
            );
            const history = decodeSessionHistoryPageLoaded(
                await messages.nextKind("session.live-history.v2.page.loaded"),
            );
            expect(JSON.stringify(history.events.events.events)).toContain("Persist this Session");
        } finally {
            restored.cancellation.abort();
            await restored.completion;
        }
    } finally {
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);

test("Given queued prompts from the running Agent identity and another one, When an active-turn snapshot is taken for the running identity, Then it reports its own queued prompt with that prompt's files and excludes the foreign one", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "mobius-queued-identity-"));
    const workspace = join(stateDirectory, "workspace");
    await mkdir(workspace);
    const relay = createServer((_request, response) => response.writeHead(404).end());
    const websocketServer = new WebSocketServer({ server: relay });
    const connected = Promise.withResolvers<WebSocket>();
    websocketServer.on("connection", (socket) => connected.resolve(socket));
    await listen(relay);
    const relayUrl = new URL(
        `ws://127.0.0.1:${port(relay).toString()}${MOBIUS_API_PREFIX}/channels/queued-identity/daemon`,
    );
    relayUrl.searchParams.set("token", "r".repeat(43));
    const fakeAgentPath = fileURLToPath(new URL("./fixtures/acp-peer.ts", import.meta.url));
    const agent = new LocalAgentDefinition(
        "claude",
        "Claude Code",
        process.execPath,
        [fakeAgentPath, "--agent-name", "Claude Code"],
        {
            MOBIUS_FAKE_ACP_PAUSE_AFTER_PERMISSION: "1",
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "agent"),
        },
    );
    const otherAgent = new LocalAgentDefinition(
        "codex",
        "Codex",
        process.execPath,
        [fakeAgentPath, "--agent-name", "Codex"],
        {
            MOBIUS_FAKE_ACP_PAUSE_AFTER_PERMISSION: "1",
            MOBIUS_FAKE_ACP_STATE_DIRECTORY: join(stateDirectory, "agent"),
        },
    );
    const config = createRuntimeConfig(
        { channelId: "queued-identity", defaultWorkspace: workspace, relayUrl },
        [agent, otherAgent],
        new RuntimeLocalContext(stateDirectory),
    );
    const cancellation = new AbortController();
    const runtime = runRuntime(config, cancellation.signal);
    try {
        const socket = await connected.promise;
        const messages = new Messages(socket);
        socket.send(JSON.stringify({ kind: "runtime.liveness.ready" }));
        const sessionId = "queued_identity";
        socket.send(
            encodeSessionPromptCommand({
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: config.bindingId,
                commandId: "running_turn",
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
        expect(decodeSessionStatusChangedEvent(await messages.nextKind(SESSION_STATUS_CHANGED_KIND))).toMatchObject({
            status: { commandId: "running_turn", kind: "working" },
        });
        // A different Agent identity queues behind the running turn in the same Session.
        socket.send(
            encodeSessionPromptCommand({
                additionalDirectoryIds: [],
                agentId: "codex",
                bindingId: config.bindingId,
                commandId: "foreign_queued_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Queue,
                images: [],
                kind: "session.prompt",
                prompt: "queued for another agent",
                resources: [],
                sessionId,
                targetCommandId: "running_turn",
            }),
        );
        // The running identity queues a prompt with a file, which a client needs to restore it for editing.
        const report = {
            mimeType: "text/plain",
            name: "report.txt",
            text: "Quarterly numbers",
            type: "embedded" as const,
            uri: "file:///workspace/report.txt",
        };
        socket.send(
            encodeSessionPromptCommand({
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: config.bindingId,
                commandId: "own_queued_turn",
                directoryId: "default",
                disposition: SessionPromptDisposition.Queue,
                images: [],
                kind: "session.prompt",
                prompt: "summarize the attached report",
                resources: [report],
                sessionId,
                targetCommandId: "running_turn",
            }),
        );
        // The snapshot for the Claude identity must not report the Codex queued prompt.
        socket.send(
            encodeNativeSessionRequest({
                action: "active-turn",
                additionalDirectoryIds: [],
                agentId: "claude",
                bindingId: config.bindingId,
                directoryId: "default",
                kind: "native.session.request",
                requestId: "claude_snapshot",
                sessionId,
                targetSessionId: sessionId,
            }),
        );
        const result = decodeNativeSessionResult(await messages.nextKind(NATIVE_SESSION_RESULT_KIND));
        expect(result.action).toBe("active-turn");
        if (result.action === "active-turn") {
            expect(result.queued).toEqual([
                {
                    commandId: "own_queued_turn",
                    prompt: "summarize the attached report",
                    images: [],
                    resources: [report],
                },
            ]);
            expect(result.turn?.commandId).toBe("running_turn");
        }
    } finally {
        cancellation.abort();
        await runtime;
        for (const socket of websocketServer.clients) {
            socket.terminate();
        }
        await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        await rm(stateDirectory, { recursive: true, force: true });
    }
}, 30_000);
