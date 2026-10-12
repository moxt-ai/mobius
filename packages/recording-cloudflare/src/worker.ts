import { DurableObject } from "cloudflare:workers";
import {
    decodeSessionRecordingWrite,
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
        (parts.length !== 7 && parts.length !== 9) ||
        parts[1] !== "v1" ||
        parts[2] !== "projects" ||
        parts[4] !== "runtimes" ||
        parts[6] !== "sessions" ||
        (parts.length === 9 && parts[8] !== "events")
    ) {
        return null;
    }
    try {
        const projectId = decodeURIComponent(parts[3] ?? "");
        const runtimeId = decodeURIComponent(parts[5] ?? "");
        const sessionId = parts.length === 9 ? decodeURIComponent(parts[7] ?? "") : null;
        return isIdentifier(projectId) && isIdentifier(runtimeId) && (sessionId === null || isIdentifier(sessionId))
            ? { projectId, runtimeId, sessionId }
            : null;
    } catch {
        return null;
    }
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
                return Response.json({ recorded: true }, { status: 201 });
            }
            const target = targetFromPath(url.pathname);
            if (request.method !== "GET" || target === null) {
                return errorResponse("not_found", 404);
            }
            const query = new URLSearchParams({ projectId: target.projectId, runtimeId: target.runtimeId });
            if (target.sessionId === null) {
                return await environment.RECORDING_DIRECTORY.getByName(
                    JSON.stringify([target.projectId, target.runtimeId]),
                ).fetch(new Request(`https://directory.internal/sessions?${query}`, { signal: request.signal }));
            }
            query.set("sessionId", target.sessionId);
            const incremental = incrementalReadQuery(url);
            if (incremental !== null) {
                if ("error" in incremental) {
                    return errorResponse("invalid_request", 400);
                }
                query.set("after", incremental.after.toString());
                query.set("limit", incremental.limit.toString());
                return await environment.SESSION_RECORDING.getByName(
                    JSON.stringify([target.projectId, target.sessionId]),
                ).fetch(new Request(`https://recording.internal/page-events?${query}`, { signal: request.signal }));
            }
            return await environment.SESSION_RECORDING.getByName(
                JSON.stringify([target.projectId, target.sessionId]),
            ).fetch(new Request(`https://recording.internal/events?${query}`, { signal: request.signal }));
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
        if (request.method === "GET" && url.pathname === "/sessions" && isIdentifier(runtimeId)) {
            return new Response(encodeSessionRecordingDirectory(this.#directory.read(runtimeId)), {
                headers: { "content-type": "application/json" },
            });
        }
        return errorResponse("not_found", 404);
    }
}
export default createRecordingWorker();
