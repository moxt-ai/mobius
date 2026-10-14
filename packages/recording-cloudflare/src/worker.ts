import { DurableObject } from "cloudflare:workers";
import {
    decodeSessionRecordingWrite,
    encodeSessionRecordingDirectory,
    isIdentifier,
    ProtocolMessageError,
    type SessionRecordingWrite,
} from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";
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

type RecordingEnvironment = { readonly Bindings: RecordingWorkerBindings };
type SessionRecordingRoutes = Pick<SessionRecordingStorage, "append" | "read" | "readPage">;
const jsonHeaders = { "content-type": "application/json" } as const;

function errorResponse(code: string, status: number): Response {
    return Response.json({ error: { code, message: "The Recording request could not be completed" } }, { status });
}

/**
 * Reports an unexpected failure through the same envelope callers already parse, so an unhandled
 * read never degrades to Hono's plain-text "Internal Server Error". The cause stays in Workers
 * logs because the sanitized body deliberately omits it.
 */
function internalErrorResponse(cause: unknown, request: Request): Response {
    // Cancellation belongs to the caller and must not be translated into a Worker failure.
    if (request.signal.aborted) {
        throw cause;
    }
    // The Durable Object pathname alone cannot identify a Session, so the target query is logged
    // with the cause. Observability needs the identifier; the client response does not get it.
    const url = new URL(request.url);
    console.error(`Recording ${request.method} ${url.pathname}${url.search} failed`, cause);
    return errorResponse("internal_error", 500);
}

function decodedIdentifier(value: string | undefined): string | null {
    if (value === undefined) {
        return null;
    }
    try {
        const decoded = decodeURIComponent(value);
        return isIdentifier(decoded) ? decoded : null;
    } catch {
        return null;
    }
}

function requireSingleSession(write: SessionRecordingWrite): SessionRecordingWrite {
    const [firstEvent] = write.envelope.events;
    if (firstEvent !== undefined && write.envelope.events.every((event) => event.sessionId === firstEvent.sessionId)) {
        return write;
    }
    throw new ProtocolMessageError("A Recording batch must target one Session");
}

function sessionRecordingRoutes(storage: SessionRecordingRoutes): Hono<RecordingEnvironment> {
    return new Hono<RecordingEnvironment>()
        .onError((cause, context): Response => internalErrorResponse(cause, context.req.raw))
        .post("/events", async (context): Promise<Response> => {
            try {
                return storage.append(requireSingleSession(await decode(context.req.raw)))
                    ? context.json({ recorded: true }, 201)
                    : errorResponse("recording_identity_conflict", 409);
            } catch (cause) {
                return envelopeError(cause);
            }
        })
        .get("/events", (context): Response => {
            const target = eventTarget(context.req.raw);
            if (target === null) {
                return errorResponse("invalid_target", 400);
            }
            return historyResponse(storage.read(target.projectId, target.runtimeId, target.sessionId));
        })
        .get("/page-events", (context): Response => {
            const target = eventTarget(context.req.raw);
            const after = context.req.query("after");
            const limit = context.req.query("limit");
            if (
                target === null ||
                after === undefined ||
                limit === undefined ||
                !/^(?:(?:0|[1-9][0-9]*)|v2:[1-9][0-9]*:(?:0|[1-9][0-9]*))$/.test(after) ||
                !/^[1-9][0-9]{0,4}$/.test(limit)
            ) {
                return errorResponse("invalid_target", 400);
            }
            const page = storage.readPage(target.projectId, target.runtimeId, target.sessionId, after, Number(limit));
            return historyResponse(page);
        })
        .all("*", (): Response => errorResponse("not_found", 404));
}

function recordingDirectoryRoutes(
    storage: RecordingDirectoryStorage,
    directory: RecordingDirectory,
): Hono<RecordingEnvironment> {
    return new Hono<RecordingEnvironment>()
        .onError((cause, context): Response => internalErrorResponse(cause, context.req.raw))
        .post("/events", async (context): Promise<Response> => {
            try {
                directory.record(await decode(context.req.raw));
                return context.body(null, 204);
            } catch (cause) {
                return envelopeError(cause);
            }
        })
        .get("/sessions", (context): Response => {
            const runtimeId = decodedIdentifier(context.req.query("runtimeId"));
            const sessionIds = context.req.queries("sessionId") ?? [];
            if (runtimeId === null || sessionIds.some((sessionId) => !isIdentifier(sessionId))) {
                return errorResponse("invalid_target", 400);
            }
            const result =
                sessionIds.length === 0
                    ? storage.read(runtimeId)
                    : {
                          sessions: sessionIds.flatMap((sessionId) => {
                              const summary = storage.find(sessionId);
                              return summary?.runtimeId === runtimeId ? [summary] : [];
                          }),
                      };
            return context.body(encodeSessionRecordingDirectory(result), 200, jsonHeaders);
        })
        .get("/summary", (context): Response => {
            const runtimeId = decodedIdentifier(context.req.query("runtimeId"));
            const sessionId = decodedIdentifier(context.req.query("sessionId"));
            if (runtimeId === null || sessionId === null) {
                return errorResponse("invalid_target", 400);
            }
            const summary = storage.find(sessionId);
            return summary === null || summary.runtimeId !== runtimeId
                ? errorResponse("not_found", 404)
                : context.json(summary);
        })
        .all("*", (): Response => errorResponse("not_found", 404));
}

async function decode(request: Request): Promise<SessionRecordingWrite> {
    return decodeSessionRecordingWrite(await request.text());
}

function envelopeError(cause: unknown): Response {
    if (cause instanceof ProtocolMessageError) {
        return errorResponse("invalid_envelope", 400);
    }
    throw cause;
}

function eventTarget(request: Request): {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
} | null {
    const query = new URL(request.url).searchParams;
    const projectId = decodedIdentifier(query.get("projectId") ?? undefined);
    const runtimeId = decodedIdentifier(query.get("runtimeId") ?? undefined);
    const sessionId = decodedIdentifier(query.get("sessionId") ?? undefined);
    return projectId === null || runtimeId === null || sessionId === null ? null : { projectId, runtimeId, sessionId };
}

function historyResponse<T>(value: T | null): Response {
    return value === null ? errorResponse("not_found", 404) : Response.json(value);
}

const maximumPageEvents = 10_000;

function incrementalReadQuery(query: Record<string, string | undefined>) {
    const after = query["after"];
    const limit = query["limit"];
    if (after === undefined && limit === undefined) {
        return null;
    }
    if (after !== undefined && !/^(?:(?:0|[1-9][0-9]*)|v2:[1-9][0-9]*:(?:0|[1-9][0-9]*))$/.test(after)) {
        return { error: true };
    }
    if (limit !== undefined && !/^[1-9][0-9]{0,4}$/.test(limit)) {
        return { error: true };
    }
    const boundedLimit = limit === undefined ? maximumPageEvents : Number(limit);
    if (boundedLimit > maximumPageEvents) {
        return { error: true };
    }
    return { after: after === undefined ? "0" : after, limit: boundedLimit };
}

function readTarget(context: { readonly req: { readonly param: (name: string) => string | undefined } }) {
    const projectId = decodedIdentifier(context.req.param("projectId"));
    const runtimeId = decodedIdentifier(context.req.param("runtimeId"));
    const sessionId = decodedIdentifier(context.req.param("sessionId"));
    return { projectId, runtimeId, sessionId };
}

function durableObjectFetch(namespace: DurableObjectNamespace, name: string, request: Request): Promise<Response> {
    return namespace.getByName(name).fetch(request);
}

export function createRecordingWorker(): RecordingWorker {
    const application = new Hono<RecordingEnvironment>()
        // Durable Object fetches reject rather than returning an error Response, and every route
        // passes a Durable Object response straight through, so the envelope has to be added here.
        .onError((cause, context): Response => internalErrorResponse(cause, context.req.raw))
        .post("/v1/session-events", async (context): Promise<Response> => {
            let write: SessionRecordingWrite;
            try {
                write = requireSingleSession(await decode(context.req.raw));
            } catch (cause) {
                if (cause instanceof ProtocolMessageError) {
                    return errorResponse("invalid_envelope", 400);
                }
                throw cause;
            }
            const { projectId, runtimeId } = write;
            const [firstEvent] = write.envelope.events;
            if (firstEvent === undefined) {
                return errorResponse("invalid_envelope", 400);
            }
            const body = JSON.stringify(write);
            const recorded = await durableObjectFetch(
                context.env.SESSION_RECORDING,
                JSON.stringify([projectId, firstEvent.sessionId]),
                new Request("https://recording.internal/events", {
                    method: "POST",
                    body,
                    signal: context.req.raw.signal,
                }),
            );
            if (!recorded.ok) {
                return recorded;
            }
            await recorded.body?.cancel();
            const indexed = await durableObjectFetch(
                context.env.RECORDING_DIRECTORY,
                JSON.stringify([projectId, runtimeId]),
                new Request("https://directory.internal/events", {
                    method: "POST",
                    body,
                    signal: context.req.raw.signal,
                }),
            );
            return indexed.ok ? context.json({ recorded: true }, 201) : errorResponse("storage_unavailable", 503);
        })
        .get("/v1/projects/:projectId/runtimes/:runtimeId/sessions", async (context): Promise<Response> => {
            const target = readTarget(context);
            if (target.projectId === null || target.runtimeId === null) {
                return errorResponse("not_found", 404);
            }
            const sessionIds = context.req.queries("sessionId") ?? [];
            if (sessionIds.some((sessionId) => !isIdentifier(sessionId))) {
                return errorResponse("invalid_target", 400);
            }
            const query = new URLSearchParams({
                projectId: target.projectId,
                runtimeId: target.runtimeId,
            });
            for (const sessionId of sessionIds) {
                query.append("sessionId", sessionId);
            }
            return await durableObjectFetch(
                context.env.RECORDING_DIRECTORY,
                JSON.stringify([target.projectId, target.runtimeId]),
                new Request(`https://directory.internal/sessions?${query}`, { signal: context.req.raw.signal }),
            );
        })
        .get("/v1/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId", async (context): Promise<Response> => {
            const target = readTarget(context);
            if (target.projectId === null || target.runtimeId === null || target.sessionId === null) {
                return errorResponse("not_found", 404);
            }
            const query = new URLSearchParams({
                projectId: target.projectId,
                runtimeId: target.runtimeId,
                sessionId: target.sessionId,
            });
            return await durableObjectFetch(
                context.env.RECORDING_DIRECTORY,
                JSON.stringify([target.projectId, target.runtimeId]),
                new Request(`https://directory.internal/summary?${query}`, { signal: context.req.raw.signal }),
            );
        })
        .get(
            "/v1/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/events",
            async (context): Promise<Response> => {
                const target = readTarget(context);
                if (target.projectId === null || target.runtimeId === null || target.sessionId === null) {
                    return errorResponse("not_found", 404);
                }
                const incremental = incrementalReadQuery(context.req.query());
                if (incremental !== null && "error" in incremental) {
                    return errorResponse("invalid_request", 400);
                }
                const query = new URLSearchParams({
                    projectId: target.projectId,
                    runtimeId: target.runtimeId,
                    sessionId: target.sessionId,
                });
                const path = incremental === null ? "events" : "page-events";
                const cursor = incremental;
                if (cursor !== null) {
                    query.set("after", cursor["after"]);
                    query.set("limit", cursor["limit"].toString());
                }
                return await durableObjectFetch(
                    context.env.SESSION_RECORDING,
                    JSON.stringify([target.projectId, target.sessionId]),
                    new Request(`https://recording.internal/${path}?${query}`, {
                        signal: context.req.raw.signal,
                    }),
                );
            },
        )
        .all("*", (): Response => errorResponse("not_found", 404));
    return {
        fetch: async (request, environment) => await application.fetch(request, environment),
    };
}

export class SessionRecordingDurableObject extends DurableObject<RecordingWorkerBindings> {
    readonly #routes: Hono<RecordingEnvironment>;
    constructor(state: DurableObjectState, _environment: RecordingWorkerBindings) {
        super(state, _environment);
        this.#routes = sessionRecordingRoutes(new SessionRecordingStorage(state.storage));
    }
    override async fetch(request: Request): Promise<Response> {
        return await this.#routes.fetch(request);
    }
}

export class RecordingDirectoryDurableObject extends DurableObject<RecordingWorkerBindings> {
    readonly #routes: Hono<RecordingEnvironment>;
    constructor(state: DurableObjectState, _environment: RecordingWorkerBindings) {
        super(state, _environment);
        const storage = new RecordingDirectoryStorage(state.storage);
        this.#routes = recordingDirectoryRoutes(storage, new RecordingDirectory(storage));
    }
    override async fetch(request: Request): Promise<Response> {
        return await this.#routes.fetch(request);
    }
}

export default createRecordingWorker();
