import { DurableObject } from "cloudflare:workers";
import {
    decodeSessionRecordingWrite,
    encodeMobiusSessionExportV2,
    encodeSessionHistorySources,
    encodeSessionRecordingDirectory,
    encodeSessionRecordingHistory,
    encodeSessionRecordingHistoryPage,
    isIdentifier,
    ProtocolMessageError,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import { RecordingDirectory } from "./service/recording-directory.ts";
import { RecordingDirectoryStorage } from "./storage/recording-directory-storage.ts";
import { SessionRecordingStorage } from "./storage/session-recording-storage.ts";

export interface RecordingWorkerBindings {
    readonly RECORDING_DIRECTORY: DurableObjectNamespace<RecordingDirectoryDurableObject>;
    readonly SESSION_RECORDING: DurableObjectNamespace<SessionRecordingDurableObject>;
}
export interface RecordingWorker {
    readonly fetch: (request: Request, environment: RecordingWorkerBindings) => Promise<Response>;
}
function errorResponse(code: string, status: number): Response {
    return Response.json({ error: { code, message: "The Recording request could not be completed" } }, { status });
}
const MAXIMUM_PAGE_EVENTS = 10_000;

/**
 * Validates the incremental-read query. Absent fields mean the caller wants the original
 * full-history contract, which keeps serving complete unbounded history.
 */
function incrementalReadQuery(
    url: URL,
): { readonly after: number; readonly limit: number } | { readonly error: string } | null {
    const after = url.searchParams.get("after");
    const limit = url.searchParams.get("limit");
    if (after === null && limit === null) {
        return null;
    }
    if (after !== null && !/^(?:0|[1-9][0-9]*)$/.test(after)) {
        return { error: "The after cursor must be a position" };
    }
    if (limit !== null && !/^[1-9][0-9]{0,4}$/.test(limit)) {
        return { error: "The limit must be a positive event count" };
    }
    const boundedLimit = limit === null ? MAXIMUM_PAGE_EVENTS : Number(limit);
    if (boundedLimit > MAXIMUM_PAGE_EVENTS) {
        return { error: "The limit must be a positive event count" };
    }
    return { after: after === null ? 0 : Number(after), limit: boundedLimit };
}
function targetFromPath(
    pathname: string,
): { readonly projectId: string; readonly runtimeId: string; readonly sessionId: string | null } | null {
    const parts = pathname.split("/");
    if (
        parts.length < 7 ||
        parts[1] !== "v1" ||
        parts[2] !== "projects" ||
        parts[4] !== "runtimes" ||
        parts[6] !== "sessions"
    ) {
        return null;
    }
    try {
        const projectId = decodeURIComponent(parts[3] ?? "");
        const runtimeId = decodeURIComponent(parts[5] ?? "");
        const sessionId = parts.length > 7 ? decodeURIComponent(parts[7] ?? "") : null;
        return isIdentifier(projectId) && isIdentifier(runtimeId) && (sessionId === null || isIdentifier(sessionId))
            ? { projectId, runtimeId, sessionId }
            : null;
    } catch {
        return null;
    }
}

function sessionIdFromPath(pathname: string): string | null {
    const parts = pathname.split("/");
    if (parts.length < 4 || parts[1] !== "v1" || parts[2] !== "sessions") {
        return null;
    }
    try {
        const sessionId = decodeURIComponent(parts[3] ?? "");
        return isIdentifier(sessionId) ? sessionId : null;
    } catch {
        return null;
    }
}

async function resolveTarget(
    request: Request,
    environment: RecordingWorkerBindings,
    sessionId: string,
): Promise<{ readonly projectId: string; readonly runtimeId: string; readonly sessionId: string } | null> {
    const response = await environment.RECORDING_DIRECTORY.getByName(JSON.stringify(["index", "sessions"])).fetch(
        new Request(`https://directory.internal/target?sessionId=${encodeURIComponent(sessionId)}`, {
            signal: request.signal,
        }),
    );
    if (!response.ok) {
        await response.body?.cancel();
        return null;
    }
    const value: unknown = await response.json();
    return typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "projectId" in value &&
        "runtimeId" in value
        ? { projectId: String(value.projectId), runtimeId: String(value.runtimeId), sessionId }
        : null;
}

async function sessionStorageRequest(
    environment: RecordingWorkerBindings,
    target: { readonly projectId: string; readonly runtimeId: string; readonly sessionId: string },
    path: string,
    request: Request,
    body?: string,
): Promise<Response> {
    return await environment.SESSION_RECORDING.getByName(JSON.stringify([target.projectId, target.sessionId])).fetch(
        new Request(`https://recording.internal${path}`, {
            method: request.method,
            headers: request.headers,
            ...(body === undefined ? {} : { body }),
            signal: request.signal,
        }),
    );
}

async function directoryRequest(
    environment: RecordingWorkerBindings,
    projectId: string,
    runtimeId: string,
    path: string,
    request: Request,
    body?: string,
): Promise<Response> {
    return await environment.RECORDING_DIRECTORY.getByName(JSON.stringify([projectId, runtimeId])).fetch(
        new Request(`https://directory.internal${path}`, {
            method: request.method,
            headers: request.headers,
            ...(body === undefined ? {} : { body }),
            signal: request.signal,
        }),
    );
}

async function sessionMetadata(
    environment: RecordingWorkerBindings,
    target: { readonly projectId: string; readonly runtimeId: string; readonly sessionId: string },
    query: URLSearchParams,
    request: Request,
): Promise<Response> {
    const metadata = await sessionStorageRequest(environment, target, `/metadata?${query.toString()}`, request);
    if (!metadata.ok) {
        return metadata;
    }
    const value: unknown = await metadata.json();
    const summary = await directoryRequest(
        environment,
        target.projectId,
        target.runtimeId,
        `/summary?sessionId=${encodeURIComponent(target.sessionId)}`,
        request,
    );
    const summaryValue: unknown = summary.ok ? await summary.json() : null;
    return Response.json(
        typeof value === "object" && value !== null && !Array.isArray(value)
            ? { ...value, summary: summaryValue }
            : value,
        { status: metadata.status },
    );
}
export function createRecordingWorker(): RecordingWorker {
    return {
        fetch: async (request, environment) => {
            const url = new URL(request.url);
            if (request.method === "POST" && url.pathname === "/v1/session-events") {
                let write: SessionRecordingWrite;
                try {
                    write = decodeSessionRecordingWrite(await request.text());
                } catch (cause) {
                    if (cause instanceof ProtocolMessageError) {
                        return errorResponse("invalid_envelope", 400);
                    }
                    throw cause;
                }
                const { projectId, runtimeId } = write;
                const [firstEvent, ...remainingEvents] = write.envelope.events;
                if (
                    firstEvent === undefined ||
                    remainingEvents.some((event) => event.sessionId !== firstEvent.sessionId)
                ) {
                    return errorResponse("invalid_envelope", 400);
                }
                const sessionId = firstEvent.sessionId;
                const body = JSON.stringify(write);
                const recorded = await environment.SESSION_RECORDING.getByName(
                    JSON.stringify([projectId, sessionId]),
                ).fetch(
                    new Request("https://recording.internal/events", { method: "POST", body, signal: request.signal }),
                );
                if (!recorded.ok) {
                    return recorded;
                }
                await recorded.body?.cancel();
                const indexed = await environment.RECORDING_DIRECTORY.getByName(
                    JSON.stringify([projectId, runtimeId]),
                ).fetch(
                    new Request("https://directory.internal/events", { method: "POST", body, signal: request.signal }),
                );
                if (!indexed.ok) {
                    return errorResponse("storage_unavailable", 503);
                }
                const globalIndex = await environment.RECORDING_DIRECTORY.getByName(
                    JSON.stringify(["index", "sessions"]),
                ).fetch(
                    new Request("https://directory.internal/events", {
                        method: "POST",
                        body,
                        signal: request.signal,
                    }),
                );
                if (!globalIndex.ok) {
                    return errorResponse("storage_unavailable", 503);
                }
                return Response.json({ recorded: true }, { status: 201 });
            }
            const lookupPath = sessionIdFromPath(url.pathname);
            if (lookupPath !== null && url.pathname.endsWith("/target")) {
                const target = await resolveTarget(request, environment, lookupPath);
                return target === null
                    ? errorResponse("not_found", 404)
                    : Response.json(target, { headers: { "content-type": "application/json" } });
            }
            const scopedTarget = targetFromPath(url.pathname);
            const sessionId = sessionIdFromPath(url.pathname);
            const target =
                scopedTarget ?? (sessionId === null ? null : await resolveTarget(request, environment, sessionId));
            if (target === null) {
                return errorResponse("not_found", 404);
            }
            const targetSessionId = target.sessionId;
            const query = new URLSearchParams({ projectId: target.projectId, runtimeId: target.runtimeId });
            if (targetSessionId === null && request.method === "GET") {
                const directoryQuery = new URLSearchParams(url.searchParams);
                directoryQuery.set("runtimeId", target.runtimeId);
                return await directoryRequest(
                    environment,
                    target.projectId,
                    target.runtimeId,
                    `/sessions?${directoryQuery.toString()}`,
                    request,
                );
            }
            if (targetSessionId === null) {
                return errorResponse("method_not_allowed", 405);
            }
            query.set("sessionId", targetSessionId);
            const sessionTarget = {
                projectId: target.projectId,
                runtimeId: target.runtimeId,
                sessionId: targetSessionId,
            };
            if (
                request.method === "GET" &&
                (url.pathname === `/v1/sessions/${encodeURIComponent(targetSessionId)}` ||
                    url.pathname.endsWith(`/sessions/${encodeURIComponent(targetSessionId)}`))
            ) {
                return await sessionMetadata(environment, sessionTarget, query, request);
            }
            if (request.method === "GET" && url.pathname.endsWith("/metadata")) {
                return await sessionMetadata(environment, sessionTarget, query, request);
            }
            if (request.method === "GET" && url.pathname.endsWith("/status")) {
                return await sessionStorageRequest(environment, sessionTarget, `/status?${query.toString()}`, request);
            }
            if (request.method === "GET" && url.pathname.endsWith("/delivery")) {
                return await sessionStorageRequest(
                    environment,
                    sessionTarget,
                    `/delivery?${query.toString()}`,
                    request,
                );
            }
            if (request.method === "GET" && url.pathname.endsWith("/history")) {
                return await sessionStorageRequest(environment, sessionTarget, `/history?${query.toString()}`, request);
            }
            if (request.method === "GET" && url.pathname.endsWith("/export")) {
                return await sessionStorageRequest(environment, sessionTarget, `/export?${query.toString()}`, request);
            }
            if (request.method === "GET" && url.pathname.endsWith("/retention")) {
                return await sessionStorageRequest(
                    environment,
                    sessionTarget,
                    `/retention?${query.toString()}`,
                    request,
                );
            }
            if (request.method === "DELETE") {
                const deleted = await sessionStorageRequest(
                    environment,
                    sessionTarget,
                    `/delete?${query.toString()}`,
                    request,
                );
                if (!deleted.ok) {
                    return deleted;
                }
                await directoryRequest(
                    environment,
                    target.projectId,
                    target.runtimeId,
                    `/sessions/${encodeURIComponent(targetSessionId)}`,
                    new Request("https://directory.internal", { method: "DELETE", signal: request.signal }),
                );
                await environment.RECORDING_DIRECTORY.getByName(JSON.stringify(["index", "sessions"])).fetch(
                    new Request(`https://directory.internal/sessions/${encodeURIComponent(targetSessionId)}`, {
                        method: "DELETE",
                        signal: request.signal,
                    }),
                );
                return new Response(null, { status: 204 });
            }
            if (request.method === "POST" && url.pathname.endsWith("/events")) {
                return await sessionStorageRequest(
                    environment,
                    sessionTarget,
                    "/events",
                    request,
                    await request.text(),
                );
            }
            if (request.method !== "GET") {
                return errorResponse("method_not_allowed", 405);
            }
            const incremental = incrementalReadQuery(url);
            if (incremental !== null) {
                if ("error" in incremental) {
                    return errorResponse("invalid_request", 400);
                }
                query.set("after", incremental.after.toString());
                query.set("limit", incremental.limit.toString());
                return await sessionStorageRequest(
                    environment,
                    sessionTarget,
                    `/page-events?${query.toString()}`,
                    request,
                );
            }
            return await sessionStorageRequest(environment, sessionTarget, `/events?${query.toString()}`, request);
        },
    };
}
export class SessionRecordingDurableObject extends DurableObject<RecordingWorkerBindings> {
    readonly #recordings: SessionRecordingStorage;
    constructor(state: DurableObjectState, environment: RecordingWorkerBindings) {
        super(state, environment);
        this.#recordings = new SessionRecordingStorage(state.storage);
    }
    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/events") {
            try {
                const write = decodeSessionRecordingWrite(await request.text());
                return this.#recordings.append(write)
                    ? Response.json({ recorded: true }, { status: 201 })
                    : errorResponse("recording_identity_conflict", 409);
            } catch (cause) {
                if (cause instanceof ProtocolMessageError) {
                    return errorResponse("invalid_envelope", 400);
                }
                throw cause;
            }
        }
        if (request.method === "GET" && url.pathname === "/events") {
            const projectId = url.searchParams.get("projectId");
            const runtimeId = url.searchParams.get("runtimeId");
            const sessionId = url.searchParams.get("sessionId");
            if (!isIdentifier(projectId) || !isIdentifier(runtimeId) || !isIdentifier(sessionId)) {
                return errorResponse("invalid_target", 400);
            }
            const history = this.#recordings.read(projectId, runtimeId, sessionId);
            return history === null
                ? errorResponse("not_found", 404)
                : new Response(encodeSessionRecordingHistory(history), {
                      headers: { "content-type": "application/json" },
                  });
        }
        if (request.method === "GET" && url.pathname === "/metadata") {
            return this.#readState(request, "metadata");
        }
        if (request.method === "GET" && url.pathname === "/status") {
            return this.#readState(request, "status");
        }
        if (request.method === "GET" && url.pathname === "/delivery") {
            return this.#readState(request, "delivery");
        }
        if (request.method === "GET" && url.pathname === "/history") {
            return this.#readState(request, "history");
        }
        if (request.method === "GET" && url.pathname === "/retention") {
            return this.#readState(request, "retention");
        }
        if (request.method === "GET" && url.pathname === "/export") {
            const projectId = url.searchParams.get("projectId");
            const runtimeId = url.searchParams.get("runtimeId");
            const sessionId = url.searchParams.get("sessionId");
            if (!isIdentifier(projectId) || !isIdentifier(runtimeId) || !isIdentifier(sessionId)) {
                return errorResponse("invalid_target", 400);
            }
            const history = this.#recordings.read(projectId, runtimeId, sessionId);
            if (history === null) {
                return errorResponse("not_found", 404);
            }
            const events = history.events.slice(0, 10_000);
            return new Response(
                encodeMobiusSessionExportV2({
                    formatVersion: "2",
                    session: {
                        binding: { bindingId: "workspace", runtimeId },
                        events,
                        sessionId,
                        truncated: history.events.length > events.length,
                    },
                }),
                { headers: { "content-type": "application/json" } },
            );
        }
        if (request.method === "DELETE" && url.pathname === "/delete") {
            const projectId = url.searchParams.get("projectId");
            const runtimeId = url.searchParams.get("runtimeId");
            const sessionId = url.searchParams.get("sessionId");
            return isIdentifier(projectId) &&
                isIdentifier(runtimeId) &&
                isIdentifier(sessionId) &&
                this.#recordings.delete(projectId, runtimeId, sessionId)
                ? new Response(null, { status: 204 })
                : errorResponse("not_found", 404);
        }
        if (request.method === "GET" && url.pathname === "/page-events") {
            const projectId = url.searchParams.get("projectId");
            const runtimeId = url.searchParams.get("runtimeId");
            const sessionId = url.searchParams.get("sessionId");
            const after = url.searchParams.get("after");
            const limit = url.searchParams.get("limit");
            if (
                !isIdentifier(projectId) ||
                !isIdentifier(runtimeId) ||
                !isIdentifier(sessionId) ||
                after === null ||
                !/^(?:0|[1-9][0-9]*)$/.test(after) ||
                limit === null ||
                !/^[1-9][0-9]{0,4}$/.test(limit)
            ) {
                return errorResponse("invalid_target", 400);
            }
            const page = this.#recordings.readPage(projectId, runtimeId, sessionId, Number(after), Number(limit));
            return page === null
                ? errorResponse("not_found", 404)
                : new Response(encodeSessionRecordingHistoryPage(page), {
                      headers: { "content-type": "application/json" },
                  });
        }
        return errorResponse("not_found", 404);
    }

    #readState(request: Request, kind: "metadata" | "status" | "delivery" | "history" | "retention"): Response {
        const url = new URL(request.url);
        const projectId = url.searchParams.get("projectId");
        const runtimeId = url.searchParams.get("runtimeId");
        const sessionId = url.searchParams.get("sessionId");
        if (!isIdentifier(projectId) || !isIdentifier(runtimeId) || !isIdentifier(sessionId)) {
            return errorResponse("invalid_target", 400);
        }
        const integrity = this.#recordings.readIntegrity(projectId, runtimeId, sessionId);
        const delivery = this.#recordings.readDelivery(projectId, runtimeId, sessionId);
        const retention = this.#recordings.readRetention(projectId, runtimeId, sessionId);
        if (integrity === null || delivery === null || retention === null) {
            return errorResponse("not_found", 404);
        }
        const headers = { "content-type": "application/json" };
        if (kind === "status") {
            return Response.json({ integrity }, { headers });
        }
        if (kind === "delivery") {
            return Response.json(delivery, { headers });
        }
        if (kind === "retention") {
            return Response.json(retention, { headers });
        }
        if (kind === "history") {
            return new Response(
                encodeSessionHistorySources({
                    projectId,
                    recommended: "recording",
                    runtimeId,
                    sessionId,
                    sources: [
                        { kind: "recording", state: "available" },
                        { kind: "runtime-live", state: "unknown" },
                        { kind: "native", state: "unknown" },
                    ],
                }),
                { headers },
            );
        }
        return Response.json(
            {
                projectId,
                recording: { delivery, integrity, retention, state: "available" },
                runtimeId,
                sessionId,
                summary: null,
            },
            { headers },
        );
    }
}
export class RecordingDirectoryDurableObject extends DurableObject<RecordingWorkerBindings> {
    readonly #directory: RecordingDirectoryStorage;
    readonly #recordingDirectory: RecordingDirectory;
    constructor(state: DurableObjectState, environment: RecordingWorkerBindings) {
        super(state, environment);
        this.#directory = new RecordingDirectoryStorage(state.storage);
        this.#recordingDirectory = new RecordingDirectory(this.#directory);
    }
    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/events") {
            try {
                this.#recordingDirectory.record(decodeSessionRecordingWrite(await request.text()));
                return new Response(null, { status: 204 });
            } catch (cause) {
                if (cause instanceof ProtocolMessageError) {
                    return errorResponse("invalid_envelope", 400);
                }
                throw cause;
            }
        }
        const runtimeId = url.searchParams.get("runtimeId");
        if (request.method === "GET" && url.pathname === "/target") {
            const sessionId = url.searchParams.get("sessionId");
            return isIdentifier(sessionId)
                ? Response.json(this.#directory.findTarget(sessionId) ?? {})
                : errorResponse("invalid_request", 400);
        }
        if (request.method === "GET" && url.pathname === "/summary") {
            const sessionId = url.searchParams.get("sessionId");
            return isIdentifier(sessionId)
                ? Response.json(this.#directory.findSummary(sessionId) ?? {})
                : errorResponse("invalid_request", 400);
        }
        if (request.method === "GET" && url.pathname === "/sessions" && isIdentifier(runtimeId)) {
            const cursor = url.searchParams.get("cursor");
            const limit = Number(url.searchParams.get("limit") ?? "100");
            const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
            const status = url.searchParams.get("status");
            return new Response(
                encodeSessionRecordingDirectory(
                    this.#directory.read(runtimeId, {
                        cursor,
                        limit,
                        query,
                        status: status === "running" || status === "idle" || status === "failed" ? status : null,
                    }),
                ),
                {
                    headers: { "content-type": "application/json" },
                },
            );
        }
        if (request.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
            const sessionId = decodeURIComponent(url.pathname.slice("/sessions/".length));
            return isIdentifier(sessionId) && this.#directory.delete(sessionId)
                ? new Response(null, { status: 204 })
                : errorResponse("not_found", 404);
        }
        return errorResponse("not_found", 404);
    }
}
export default createRecordingWorker();
