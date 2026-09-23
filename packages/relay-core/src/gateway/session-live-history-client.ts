import {
    decodeMessageKind,
    decodeSessionLiveHistoryLoaded,
    decodeSessionLiveHistoryPageLoaded,
    encodeSessionLiveHistoryLoad,
    encodeSessionLiveHistoryPageLoad,
    type NativeMessagePage,
    type NativeSessionHistory,
    type SessionLiveHistoryLoaded,
    type SessionLiveHistoryPageLoaded,
} from "@moxt-ai/mobius-protocol";
import { CreateSessionRequest, SessionRecordingPolicy } from "../entity/do/session.ts";
import type { SqlDatabase } from "../infra/sql-database.ts";

const LIVE_HISTORY_TIMEOUT_MILLISECONDS = 15_000;
const INTERNAL_CHANNEL_ID_HEADER = "x-mobius-channel-id";
const INTERNAL_RUNTIME_ID_HEADER = "x-mobius-runtime-id";

interface SessionRoute {
    readonly agentId: string;
    readonly bindingId: string;
    readonly channelId: string;
    readonly directoryId: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly summary: Readonly<Record<string, unknown>>;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : null;
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) {
        throw new Error("The Session directory returned an invalid live-history route");
    }
    return field;
}

function integerField(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new Error("The Session directory returned invalid restoration metadata");
    }
    return field;
}

export class SessionLiveHistoryClient {
    readonly #runtimeRelay: DurableObjectNamespace;
    readonly #database: (projectId: string) => SqlDatabase;

    constructor(runtimeRelay: DurableObjectNamespace, database: (projectId: string) => SqlDatabase) {
        this.#runtimeRelay = runtimeRelay;
        this.#database = database;
    }

    readonly restore = async (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<{
        readonly createdAt: number;
        readonly history: NativeSessionHistory;
        readonly request: CreateSessionRequest;
    }> => {
        const route = await this.route(projectId, runtimeId, sessionId, signal);
        const policy = record(route.summary["policy"]);
        const createdAt = Date.parse(stringField(route.summary, "createdAt"));
        const level = policy?.["level"];
        if (policy === null || (level !== "full" && level !== "summary") || !Number.isFinite(createdAt)) {
            throw new Error("The Session directory returned invalid restoration metadata");
        }
        const request = new CreateSessionRequest(
            sessionId,
            runtimeId,
            route.agentId,
            route.bindingId,
            route.directoryId,
            new SessionRecordingPolicy(
                level,
                integerField(policy, "retentionMilliseconds"),
                integerField(policy, "hotEventLimit"),
                integerField(policy, "contentLimitBytes"),
                integerField(policy, "idempotencyRetentionMilliseconds"),
            ),
            typeof route.summary["title"] === "string" ? route.summary["title"] : "",
            stringField(route.summary, "createdBy"),
        );
        const loaded = await this.load(route, sessionId, signal);
        const history = loaded.history;
        return { createdAt, history, request };
    };

    readonly restorePage = async (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        page: { readonly cursor: string | null; readonly limit: number },
        signal: AbortSignal,
    ): Promise<NativeMessagePage> => {
        const route = await this.route(projectId, runtimeId, sessionId, signal);
        const loaded = await this.loadPage(route, sessionId, page, signal);
        return loaded.page;
    };

    private readonly load = async (
        route: SessionRoute,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionLiveHistoryLoaded> => {
        const requestId = crypto.randomUUID();
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(LIVE_HISTORY_TIMEOUT_MILLISECONDS)]);
        const headers = new Headers({ Upgrade: "websocket" });
        headers.set(INTERNAL_CHANNEL_ID_HEADER, route.channelId);
        headers.set(INTERNAL_RUNTIME_ID_HEADER, route.runtimeId);
        const response = await this.#runtimeRelay.get(this.#runtimeRelay.idFromName(route.runtimeId)).fetch(
            new Request(`https://runtime.internal/projects/${encodeURIComponent(route.projectId)}/live-history`, {
                headers,
                signal: deadline,
            }),
        );
        if (response.status !== 101 || response.webSocket === null) {
            throw new Error("The Session Runtime live-history channel is unavailable");
        }
        const socket = response.webSocket;
        let cleanup = () => {};
        try {
            return await new Promise<SessionLiveHistoryLoaded>((resolve, reject) => {
                const failed = () => reject(new Error("The Session Runtime live-history channel closed"));
                const aborted = () => reject(deadline.reason);
                const received = (event: MessageEvent) => {
                    if (typeof event.data !== "string") {
                        return;
                    }
                    try {
                        if (decodeMessageKind(event.data) !== "session.live-history.loaded") {
                            return;
                        }
                        const result = decodeSessionLiveHistoryLoaded(event.data);
                        if (result.requestId === requestId && result.sessionId === sessionId) {
                            resolve(result);
                        }
                    } catch (cause) {
                        reject(new Error("The Session Runtime returned invalid live history", { cause }));
                    }
                };
                cleanup = () => {
                    deadline.removeEventListener("abort", aborted);
                    socket.removeEventListener("close", failed);
                    socket.removeEventListener("error", failed);
                    socket.removeEventListener("message", received);
                };
                deadline.addEventListener("abort", aborted, { once: true });
                socket.addEventListener("close", failed);
                socket.addEventListener("error", failed);
                socket.addEventListener("message", received);
                socket.accept();
                socket.send(
                    encodeSessionLiveHistoryLoad({
                        additionalDirectoryIds: [],
                        agentId: route.agentId,
                        bindingId: route.bindingId,
                        directoryId: route.directoryId,
                        kind: "session.live-history.load",
                        requestId,
                        sessionId,
                    }),
                );
            });
        } finally {
            cleanup();
            socket.close(1000, "Live Session history operation complete");
        }
    };

    private readonly loadPage = async (
        route: SessionRoute,
        sessionId: string,
        page: { readonly cursor: string | null; readonly limit: number },
        signal: AbortSignal,
    ): Promise<SessionLiveHistoryPageLoaded> => {
        const requestId = crypto.randomUUID();
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(LIVE_HISTORY_TIMEOUT_MILLISECONDS)]);
        const headers = new Headers({ Upgrade: "websocket" });
        headers.set(INTERNAL_CHANNEL_ID_HEADER, route.channelId);
        headers.set(INTERNAL_RUNTIME_ID_HEADER, route.runtimeId);
        const response = await this.#runtimeRelay.get(this.#runtimeRelay.idFromName(route.runtimeId)).fetch(
            new Request(`https://runtime.internal/projects/${encodeURIComponent(route.projectId)}/live-history`, {
                headers,
                signal: deadline,
            }),
        );
        if (response.status !== 101 || response.webSocket === null) {
            throw new Error("The Session Runtime live-history channel is unavailable");
        }
        const socket = response.webSocket;
        let cleanup = () => {};
        try {
            return await new Promise<SessionLiveHistoryPageLoaded>((resolve, reject) => {
                const failed = () => reject(new Error("The Session Runtime live-history channel closed"));
                const aborted = () => reject(deadline.reason);
                const received = (event: MessageEvent) => {
                    if (typeof event.data !== "string") {
                        return;
                    }
                    try {
                        if (decodeMessageKind(event.data) !== "session.live-history.page.loaded") {
                            return;
                        }
                        const result = decodeSessionLiveHistoryPageLoaded(event.data);
                        if (result.requestId === requestId && result.sessionId === sessionId) {
                            resolve(result);
                        }
                    } catch (cause) {
                        reject(new Error("The Session Runtime returned an invalid live-history page", { cause }));
                    }
                };
                cleanup = () => {
                    deadline.removeEventListener("abort", aborted);
                    socket.removeEventListener("close", failed);
                    socket.removeEventListener("error", failed);
                    socket.removeEventListener("message", received);
                };
                deadline.addEventListener("abort", aborted, { once: true });
                socket.addEventListener("close", failed);
                socket.addEventListener("error", failed);
                socket.addEventListener("message", received);
                socket.accept();
                socket.send(
                    encodeSessionLiveHistoryPageLoad({
                        additionalDirectoryIds: [],
                        agentId: route.agentId,
                        bindingId: route.bindingId,
                        cursor: page.cursor,
                        directoryId: route.directoryId,
                        kind: "session.live-history.page.load",
                        limit: page.limit,
                        requestId,
                        sessionId,
                    }),
                );
            });
        } finally {
            cleanup();
            socket.close(1000, "Live Session history page operation complete");
        }
    };

    private readonly route = async (
        projectId: string,
        runtimeId: string,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionRoute> => {
        signal.throwIfAborted();
        const row = await this.#database(projectId)
            .prepare(
                `SELECT d.summary_json, p.channel_id
                 FROM session_directory d
                 JOIN pairing_channels p
                   ON p.project_id = d.project_id AND p.runtime_id = d.runtime_id
                 WHERE d.project_id = ? AND d.session_id = ? AND d.runtime_id = ?
                   AND d.lifecycle != 'deleted' AND p.status = 'paired'`,
            )
            .bind(projectId, sessionId, runtimeId)
            .first(signal);
        signal.throwIfAborted();
        const routeRow = record(row);
        if (routeRow === null || typeof routeRow["summary_json"] !== "string") {
            throw new Error("The Session Runtime live-history route is unavailable");
        }
        let summary: unknown;
        try {
            summary = JSON.parse(routeRow["summary_json"]);
        } catch (cause) {
            throw new Error("The Session directory returned invalid routing metadata", { cause });
        }
        const session = record(summary);
        const binding = record(session?.["defaultBinding"]);
        if (session === null || binding === null) {
            throw new Error("The Session directory returned invalid routing metadata");
        }
        return {
            agentId: stringField(session, "agentId"),
            bindingId: stringField(binding, "bindingId"),
            channelId: stringField(routeRow, "channel_id"),
            directoryId: stringField(binding, "workspaceRef"),
            projectId,
            runtimeId,
            summary: session,
        };
    };
}
