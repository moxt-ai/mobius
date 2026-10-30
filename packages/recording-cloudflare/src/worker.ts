import { DurableObject } from "cloudflare:workers";
import {
    decodeSessionRecordingDirectoryV2,
    decodeSessionRecordingSummaryV2,
    decodeSessionRecordingWireWrite,
    encodeSessionRecordingDirectoryV2,
    encodeSessionRecordingExecution,
    encodeSessionRecordingTurnItemDetail,
    encodeSessionRecordingTurnItemPage,
    encodeSessionRecordingTurnPage,
    isIdentifier,
    ProtocolMessageError,
    parseSessionRecordingPageLimit,
    parseSessionRecordingTurnCursor,
    parseSessionRecordingTurnItemCursor,
    parseSessionRecordingWaitMilliseconds,
    SESSION_RECORDING_EXECUTION_COMMAND_MAX_LIMIT,
    SESSION_RECORDING_TURN_ITEM_ID_MAX_LENGTH,
    SESSION_RECORDING_TURN_ITEM_PAGE_MAX_LIMIT,
    SESSION_RECORDING_TURN_PAGE_MAX_LIMIT,
    type SessionRecordingTurnItemCursorDirection,
    type SessionRecordingWireWrite,
} from "@moxt-ai/mobius-sdk/protocol";
import { type Context, Hono } from "hono";
import { decodeKnownDirectoryUpdate } from "./entity/recording-directory-update.ts";
import { RecordingSqlMetrics } from "./infra/recording-sql-metrics.ts";
import { RecordingDirectory } from "./service/recording-directory.ts";
import { projectDirectoryUpdate } from "./service/recording-directory-update.ts";
import { RecordingEventWaiters } from "./service/recording-event-waiters.ts";
import { SessionTurnHistory, type TurnHistoryRead } from "./service/session-turn-history.ts";
import { RecordingDirectoryStorage } from "./storage/recording-directory-storage.ts";
import { type AppendOutcome, type PageRead, SessionRecordingStorage } from "./storage/session-recording-storage.ts";
import { SessionTurnHistoryStorage } from "./storage/session-turn-history-storage.ts";

export interface RecordingWorkerBindings {
    readonly RECORDING_DIRECTORY: DurableObjectNamespace<RecordingDirectoryDurableObject>;
    readonly SESSION_RECORDING: DurableObjectNamespace<SessionRecordingDurableObject>;
}
export interface RecordingWorker {
    readonly fetch: (
        request: Request,
        environment: RecordingWorkerBindings,
        executionContext?: ExecutionContext,
    ) => Promise<Response>;
}

type RecordingEnvironment = { readonly Bindings: RecordingWorkerBindings };
type SessionRecordingRoutes = Pick<SessionRecordingStorage, "append" | "read" | "readPage">;
type TurnHistoryRoutes = Pick<SessionTurnHistory, "execution" | "item" | "itemPage" | "project" | "turnPage">;
const jsonHeaders = { "content-type": "application/json" } as const;
// An opaque append-order cursor: the batch ordinal and the event position inside that batch.
const recordingCursorPattern = /^v2:[1-9][0-9]*:(?:0|[1-9][0-9]*)$/;
// Activity indexed after a batch is answered is abandoned after this long; later activity moves the same time.
const directoryIndexTimeoutMilliseconds = 10_000;

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

/** The invocation's execution context; a direct caller, such as a test, may not provide one. */
function optionalExecutionContext(context: Pick<Context, "executionCtx">): Context["executionCtx"] | undefined {
    try {
        return context.executionCtx;
    } catch {
        return undefined;
    }
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

function requireSingleSession(write: SessionRecordingWireWrite): SessionRecordingWireWrite {
    const [firstEvent] = write.envelope.events;
    if (firstEvent !== undefined && write.envelope.events.every((event) => event.sessionId === firstEvent.sessionId)) {
        return write;
    }
    throw new ProtocolMessageError("A Recording batch must target one Session");
}

function sessionRecordingRoutes(
    storage: SessionRecordingRoutes,
    history: TurnHistoryRoutes,
    scheduleBackfill: (at?: Date) => Promise<void>,
    metrics: RecordingSqlMetrics,
    waiters: RecordingEventWaiters,
): Hono<RecordingEnvironment> {
    return new Hono<RecordingEnvironment>()
        .onError((cause, context): Response => internalErrorResponse(cause, context.req.raw))
        .post("/events", async (context): Promise<Response> => {
            let write: SessionRecordingWireWrite;
            try {
                write = requireSingleSession(await decode(context.req.raw));
            } catch (cause) {
                return envelopeError(cause);
            }
            const before = metrics.snapshot();
            let projected = true;
            let appended: AppendOutcome;
            try {
                // Folding never throws out of `project`, so an error here is the envelope itself.
                appended = storage.append(write, (ordinal, events) => {
                    // Every stored batch is folded in order; one left for backfill leaves the rest to it too.
                    const folded = history.project(ordinal, events);
                    projected = projected && folded;
                });
            } catch (cause) {
                return envelopeError(cause);
            }
            switch (appended.kind) {
                case "identity_conflict":
                    return errorResponse("recording_identity_conflict", 409);
                case "event_too_large":
                    console.warn("Recording event exceeds a stored batch", {
                        code: "recording_event_too_large",
                        events: write.envelope.events.length,
                    });
                    return errorResponse("recording_event_too_large", 413);
                case "recorded":
                    break;
            }
            waiters.changed();
            if (!projected) {
                await scheduleBackfill();
            }
            const after = metrics.snapshot();
            console.info(
                JSON.stringify({
                    event: "recording_session_write",
                    events: write.envelope.events.length,
                    sqlReads: after.reads - before.reads,
                    sqlWrites: after.writes - before.writes,
                }),
            );
            return context.json({ recorded: true }, 201);
        })
        .get("/execution", async (context): Promise<Response> => {
            const target = eventTarget(context.req.raw);
            const commandIds = context.req.queries("commandId") ?? [];
            if (
                target === null ||
                commandIds.length > SESSION_RECORDING_EXECUTION_COMMAND_MAX_LIMIT ||
                commandIds.some((id) => !isIdentifier(id))
            ) {
                return errorResponse("invalid_target", 400);
            }
            return await turnHistoryResponse(
                history.execution(target, commandIds),
                encodeSessionRecordingExecution,
                scheduleBackfill,
            );
        })
        .get("/turns", async (context): Promise<Response> => {
            const target = eventTarget(context.req.raw);
            const before = optionalCursor(context.req.query("before"), parseSessionRecordingTurnCursor);
            const limit = boundedLimit(
                context.req.query("limit"),
                defaultTurnPageLimit,
                SESSION_RECORDING_TURN_PAGE_MAX_LIMIT,
            );
            if (target === null || before === undefined || limit === null) {
                return errorResponse("invalid_target", 400);
            }
            return await turnHistoryResponse(
                history.turnPage(target, before, limit),
                encodeSessionRecordingTurnPage,
                scheduleBackfill,
            );
        })
        .get("/turn-items", async (context): Promise<Response> => {
            const target = eventTarget(context.req.raw);
            const commandId = decodedIdentifier(context.req.query("commandId"));
            // A page reads one way, and the cursor says which: `before` reads back toward a Turn's
            // earlier work, `after` forward toward the work it is still producing. Feeding a page's
            // cursor to the other direction would overlap the run it came from and list work twice.
            const after = itemCursorParam(context.req.query("after"), "after");
            const before = itemCursorParam(context.req.query("before"), "before");
            const limit = boundedLimit(
                context.req.query("limit"),
                defaultTurnItemPageLimit,
                SESSION_RECORDING_TURN_ITEM_PAGE_MAX_LIMIT,
            );
            // A read continues one run, so it names exactly one direction: neither leaves the run
            // undefined, both would read one boundary two ways, and a cursor for the other direction
            // would overlap the run it came from.
            const malformedCursor = after === null || before === null;
            const namedOneDirection = (after === undefined) !== (before === undefined);
            if (target === null || commandId === null || malformedCursor || !namedOneDirection || limit === null) {
                return errorResponse("invalid_target", 400);
            }
            return await turnHistoryResponse(
                history.itemPage(
                    target,
                    commandId,
                    { afterSequence: after?.sequence ?? null, beforeSequence: before?.sequence ?? null },
                    limit,
                ),
                encodeSessionRecordingTurnItemPage,
                scheduleBackfill,
            );
        })
        .get("/turn-item", async (context): Promise<Response> => {
            const target = eventTarget(context.req.raw);
            const commandId = decodedIdentifier(context.req.query("commandId"));
            const itemId = turnItemId(context.req.query("itemId"));
            if (target === null || commandId === null || itemId === null) {
                return errorResponse("invalid_target", 400);
            }
            return await turnHistoryResponse(
                history.item(target, commandId, itemId),
                encodeSessionRecordingTurnItemDetail,
                scheduleBackfill,
            );
        })
        .get("/events", (context): Response => {
            const target = eventTarget(context.req.raw);
            if (target === null) {
                return errorResponse("invalid_target", 400);
            }
            return historyResponse(storage.read(target.projectId, target.runtimeId, target.sessionId));
        })
        .get("/page-events", async (context): Promise<Response> => {
            const target = eventTarget(context.req.raw);
            const after = context.req.query("after") ?? null;
            const limit = context.req.query("limit");
            const waitValue = context.req.query("waitMs");
            const waitMilliseconds = waitValue === undefined ? 0 : parseSessionRecordingWaitMilliseconds(waitValue);
            if (
                target === null ||
                limit === undefined ||
                (after !== null && !recordingCursorPattern.test(after)) ||
                !/^[1-9][0-9]{0,4}$/.test(limit) ||
                waitMilliseconds === null
            ) {
                return errorResponse("invalid_target", 400);
            }
            const startedAt = performance.now();
            let readMilliseconds = 0;
            let waitedMilliseconds = 0;
            const readPage = () => {
                const readStartedAt = performance.now();
                try {
                    return storage.readPage(target.projectId, target.runtimeId, target.sessionId, after, Number(limit));
                } finally {
                    readMilliseconds += performance.now() - readStartedAt;
                }
            };
            let read = readPage();
            // A caught-up reader, or one ahead of the first write, waits; an expired cursor never resolves.
            if (
                waitMilliseconds > 0 &&
                (read.kind === "not_found" || (read.kind === "page" && read.page.events.length === 0))
            ) {
                const waitStartedAt = performance.now();
                await waiters.wait(waitMilliseconds, context.req.raw.signal);
                waitedMilliseconds = performance.now() - waitStartedAt;
                read = readPage();
            }
            const response = pageResponse(read);
            response.headers.set(
                "Server-Timing",
                [
                    `recording-read;dur=${readMilliseconds.toFixed(1)}`,
                    `recording-wait;dur=${waitedMilliseconds.toFixed(1)}`,
                    `recording-total;dur=${(performance.now() - startedAt).toFixed(1)}`,
                ].join(","),
            );
            return response;
        })
        .all("*", (): Response => errorResponse("not_found", 404));
}

function recordingDirectoryRoutes(
    storage: RecordingDirectoryStorage,
    directory: RecordingDirectory,
    metrics: RecordingSqlMetrics,
): Hono<RecordingEnvironment> {
    return new Hono<RecordingEnvironment>()
        .onError((cause, context): Response => internalErrorResponse(cause, context.req.raw))
        .post("/updates", async (context): Promise<Response> => {
            let write: ReturnType<typeof decodeKnownDirectoryUpdate>;
            try {
                write = decodeKnownDirectoryUpdate(await context.req.json<unknown>());
            } catch {
                return errorResponse("invalid_envelope", 400);
            }
            if (write === null) {
                return context.body(null, 204);
            }
            const before = metrics.snapshot();
            directory.apply(write);
            const after = metrics.snapshot();
            console.info(
                JSON.stringify({
                    event: "recording_directory_write",
                    events: write.events,
                    sessions: write.updates.length,
                    sqlReads: after.reads - before.reads,
                    sqlWrites: after.writes - before.writes,
                }),
            );
            return context.body(null, 204);
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
            return context.body(encodeSessionRecordingDirectoryV2(result), 200, jsonHeaders);
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

async function decode(request: Request): Promise<SessionRecordingWireWrite> {
    return decodeSessionRecordingWireWrite(await request.text());
}

function envelopeError(cause: unknown): Response {
    if (cause instanceof ProtocolMessageError) {
        return errorResponse("invalid_envelope", 400);
    }
    throw cause;
}

/**
 * A Turn item cursor for one direction. `undefined` means the caller did not name that direction,
 * `null` that the value is not a cursor for it: a page's cursor fed to the other direction is
 * rejected rather than read the wrong way and list work twice.
 */
function itemCursorParam(
    value: string | undefined,
    direction: SessionRecordingTurnItemCursorDirection,
): { readonly sequence: number } | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    const parsed = parseSessionRecordingTurnItemCursor(value);
    return parsed !== null && parsed.direction === direction ? parsed : null;
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

const defaultTurnPageLimit = 20;
const defaultTurnItemPageLimit = 200;

/** Parses an optional cursor: null when absent, undefined when malformed. */
function optionalCursor(value: string | undefined, parse: (value: string) => number | null): number | null | undefined {
    return value === undefined ? null : (parse(value) ?? undefined);
}

function boundedLimit(value: string | undefined, fallback: number, maximum: number): number | null {
    return value === undefined ? fallback : parseSessionRecordingPageLimit(value, maximum);
}

function turnItemId(value: string | undefined): string | null {
    return value === undefined || value.length === 0 || value.length > SESSION_RECORDING_TURN_ITEM_ID_MAX_LENGTH
        ? null
        : value;
}

async function turnHistoryResponse<T>(
    read: TurnHistoryRead<T>,
    encode: (value: T) => string,
    scheduleBackfill: (at?: Date) => Promise<void>,
): Promise<Response> {
    switch (read.kind) {
        case "ready":
            return new Response(encode(read.value), { headers: jsonHeaders, status: 200 });
        case "not_found":
            return errorResponse("not_found", 404);
        case "building": {
            await scheduleBackfill();
            const response = errorResponse("projection_building", 503);
            response.headers.set("retry-after", "1");
            return response;
        }
        case "failed": {
            // Backfill retries on its own schedule; re-arming it covers an alarm that was lost.
            await scheduleBackfill(read.retryAt);
            const response = errorResponse("projection_failed", 503);
            response.headers.set("retry-after", String(read.retryAfterSeconds));
            return response;
        }
    }
}

function historyResponse<T>(value: T | null): Response {
    return value === null ? errorResponse("not_found", 404) : Response.json(value);
}

function pageResponse(read: PageRead): Response {
    switch (read.kind) {
        case "page":
            return Response.json(read.page);
        case "not_found":
            return errorResponse("not_found", 404);
        // The cursor names nothing recorded here, so the caller has to read again from a snapshot.
        case "cursor_expired":
            return errorResponse("cursor_expired", 410);
    }
}

const maximumPageEvents = 10_000;

function incrementalReadQuery(query: Record<string, string | undefined>) {
    const after = query["after"];
    const limit = query["limit"];
    const waitValue = query["waitMs"];
    const waitMilliseconds = waitValue === undefined ? 0 : parseSessionRecordingWaitMilliseconds(waitValue);
    if (waitMilliseconds === null || (waitValue !== undefined && after === undefined && limit === undefined)) {
        return { error: true };
    }
    if (after === undefined && limit === undefined) {
        return null;
    }
    if (after !== undefined && !recordingCursorPattern.test(after)) {
        return { error: true };
    }
    const pageLimit = boundedLimit(limit, maximumPageEvents, maximumPageEvents);
    if (pageLimit === null) {
        return { error: true };
    }
    return {
        after,
        limit: pageLimit,
        ...(waitValue === undefined ? {} : { waitMs: waitMilliseconds }),
    };
}

function readTarget(context: { readonly req: { readonly param: (name: string) => string | undefined } }) {
    const projectId = decodedIdentifier(context.req.param("projectId"));
    const runtimeId = decodedIdentifier(context.req.param("runtimeId"));
    const sessionId = decodedIdentifier(context.req.param("sessionId"));
    return { projectId, runtimeId, sessionId };
}

type SessionRouteContext = {
    readonly env: RecordingWorkerBindings;
    readonly req: { readonly param: (name: string) => string | undefined; readonly raw: Request };
};

function sessionQuery(context: SessionRouteContext): URLSearchParams | null {
    const target = readTarget(context);
    if (target.projectId === null || target.runtimeId === null || target.sessionId === null) {
        return null;
    }
    return new URLSearchParams({
        projectId: target.projectId,
        runtimeId: target.runtimeId,
        sessionId: target.sessionId,
    });
}

function forwardQuery(
    source: Record<string, string | undefined>,
    target: URLSearchParams,
    names: readonly string[],
): void {
    for (const name of names) {
        const value = source[name];
        if (value !== undefined) {
            target.set(name, value);
        }
    }
}

async function sessionRecordingFetch(
    context: SessionRouteContext,
    query: URLSearchParams,
    path: string,
): Promise<Response> {
    return await durableObjectFetch(
        context.env.SESSION_RECORDING,
        JSON.stringify([query.get("projectId"), query.get("sessionId")]),
        new Request(`https://recording.internal/${path}?${query}`, { signal: context.req.raw.signal }),
    );
}

function durableObjectFetch(namespace: DurableObjectNamespace, name: string, request: Request): Promise<Response> {
    return namespace.getByName(name).fetch(request);
}

async function recordingSummaryResponse(
    context: Context<RecordingEnvironment>,
    kind: "directory" | "summary",
): Promise<Response> {
    const target = readTarget(context);
    if (target.projectId === null || target.runtimeId === null || (kind === "summary" && target.sessionId === null)) {
        return errorResponse("not_found", 404);
    }
    const sessionIds =
        kind === "summary" && target.sessionId !== null ? [target.sessionId] : (context.req.queries("sessionId") ?? []);
    if (sessionIds.some((sessionId) => !isIdentifier(sessionId))) {
        return errorResponse("invalid_target", 400);
    }
    const query = new URLSearchParams({ projectId: target.projectId, runtimeId: target.runtimeId });
    for (const sessionId of sessionIds) {
        query.append("sessionId", sessionId);
    }
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(10_000)]);
    const response = await durableObjectFetch(
        context.env.RECORDING_DIRECTORY,
        JSON.stringify([target.projectId, target.runtimeId]),
        new Request(`https://directory.internal/${kind === "directory" ? "sessions" : "summary"}?${query}`, { signal }),
    );
    if (!response.ok) {
        return response;
    }
    const encoded = await response.text();
    return Response.json(
        kind === "directory"
            ? { sessions: decodeSessionRecordingDirectoryV2(encoded).sessions }
            : decodeSessionRecordingSummaryV2(encoded),
    );
}

type BatchResult =
    | { readonly sessionId: string; readonly kind: "recorded" }
    | { readonly sessionId: string; readonly kind: "failed"; readonly code: "write_failed" };

async function recordSessionBatch(
    environment: RecordingWorkerBindings,
    write: SessionRecordingWireWrite,
    signal: AbortSignal,
    background: ((task: Promise<void>) => void) | undefined,
): Promise<readonly BatchResult[]> {
    const startedAt = Date.now();
    const monotonicStartedAt = performance.now();
    let lastSessionAppendAt: number | null = null;
    const grouped = new Map<string, SessionRecordingWireWrite["envelope"]["events"][number][]>();
    for (const event of write.envelope.events) {
        const events = grouped.get(event.sessionId) ?? [];
        events.push(event);
        grouped.set(event.sessionId, events);
    }
    const entries = [...grouped];
    const results = new Map<string, BatchResult>();
    let next = 0;
    let sessionRequests = 0;
    let directoryRequests = 0;
    let directoryBodyBytes = 0;
    let pending: typeof entries = [];
    let indexed = Promise.resolve();
    let deferred = Promise.resolve();
    const deferredSignal = background === undefined ? signal : AbortSignal.timeout(directoryIndexTimeoutMilliseconds);
    // The directory is an index derived from Session histories, so its outcome never changes a Session's result.
    const index = async (body: string, requestSignal: AbortSignal): Promise<void> => {
        try {
            const response = await durableObjectFetch(
                environment.RECORDING_DIRECTORY,
                JSON.stringify([write.projectId, write.runtimeId]),
                new Request("https://directory.internal/updates", { method: "POST", body, signal: requestSignal }),
            );
            await response.body?.cancel();
            if (!response.ok) {
                console.warn("Recording directory update failed", {
                    code: "recording_directory_update_failed",
                    status: response.status,
                });
            }
        } catch (cause) {
            requestSignal.throwIfAborted();
            console.warn("Recording directory update failed", { code: "recording_directory_update_failed", cause });
        }
    };
    const flush = (): Promise<void> => {
        const batch = pending;
        pending = [];
        if (batch.length === 0) {
            return indexed;
        }
        const eventCounts = new Map(batch.map(([sessionId, events]) => [sessionId, events.length]));
        const { updates } = projectDirectoryUpdate({
            ...write,
            envelope: { kind: "session.event.v2", events: batch.flatMap(([, events]) => events) },
        });
        const body = (selected: typeof updates): string | null => {
            if (selected.length === 0) {
                return null;
            }
            const events = selected.reduce((count, { sessionId }) => count + (eventCounts.get(sessionId) ?? 0), 0);
            const encoded = JSON.stringify({
                projectId: write.projectId,
                runtimeId: write.runtimeId,
                events,
                updates: selected,
            });
            directoryBodyBytes += new TextEncoder().encode(encoded).byteLength;
            directoryRequests += 1;
            return encoded;
        };
        // A new Session or title is indexed before the batch is answered, so a Session's next batch can never
        // overtake it. Activity only moves an update time forward, so it is indexed after the answer.
        const ordered = body(updates.filter(({ operations }) => operations.some(({ kind }) => kind !== "activity")));
        const activity = body(updates.filter(({ operations }) => operations.every(({ kind }) => kind === "activity")));
        if (ordered !== null) {
            indexed = indexed.then(() => index(ordered, signal));
        }
        if (activity !== null) {
            deferred = deferred.then(() => index(activity, deferredSignal));
        }
        return indexed;
    };
    await Promise.all(
        Array.from({ length: Math.min(4, entries.length) }, async () => {
            for (;;) {
                const item = entries[next++];
                if (item === undefined) {
                    return;
                }
                const [sessionId, events] = item;
                let succeeded = false;
                sessionRequests += 1;
                try {
                    const response = await durableObjectFetch(
                        environment.SESSION_RECORDING,
                        JSON.stringify([write.projectId, sessionId]),
                        new Request("https://recording.internal/events", {
                            method: "POST",
                            body: JSON.stringify({ ...write, envelope: { kind: "session.event.v2", events } }),
                            signal,
                        }),
                    );
                    succeeded = response.ok;
                    if (succeeded) {
                        lastSessionAppendAt = Date.now();
                    }
                    await response.body?.cancel();
                } catch {
                    signal.throwIfAborted();
                }
                results.set(
                    sessionId,
                    succeeded ? { sessionId, kind: "recorded" } : { sessionId, kind: "failed", code: "write_failed" },
                );
                if (succeeded) {
                    pending.push(item);
                }
                // Bound indexing delay by a cohort, and flush the tail without waiting for other in-flight Sessions.
                if (pending.length >= 32 || next >= entries.length) {
                    await flush();
                }
            }
        }),
    );
    await flush();
    if (background === undefined) {
        await deferred;
    } else {
        background(
            deferred.catch((cause: unknown) => {
                console.warn("Recording directory activity was not indexed", {
                    code: "recording_directory_update_failed",
                    cause,
                });
            }),
        );
    }
    console.info(
        JSON.stringify({
            event: "recording_ingest",
            projectId: write.projectId,
            runtimeId: write.runtimeId,
            firstEventId: write.envelope.events.at(0)?.eventId,
            lastEventId: write.envelope.events.at(-1)?.eventId,
            startedAt,
            lastSessionAppendAt,
            completedAt: Date.now(),
            durationMs: performance.now() - monotonicStartedAt,
            events: write.envelope.events.length,
            sessionRequests,
            directoryRequests,
            directoryBodyBytes,
        }),
    );
    return entries.map(([sessionId]) => results.get(sessionId) ?? { sessionId, kind: "failed", code: "write_failed" });
}

export function createRecordingWorker(): RecordingWorker {
    const application = new Hono<RecordingEnvironment>()
        // Durable Object fetches reject rather than returning an error Response, and every route
        // passes a Durable Object response straight through, so the envelope has to be added here.
        .onError((cause, context): Response => internalErrorResponse(cause, context.req.raw))
        .post("/v1/session-event-batches", async (context): Promise<Response> => {
            let write: SessionRecordingWireWrite;
            try {
                write = await decode(context.req.raw);
            } catch (cause) {
                return envelopeError(cause);
            }
            if (new Set(write.envelope.events.map((event) => event.sessionId)).size > 256) {
                return errorResponse("invalid_envelope", 400);
            }
            const execution = optionalExecutionContext(context);
            const background = execution === undefined ? undefined : (task: Promise<void>) => execution.waitUntil(task);
            return context.json(
                { results: await recordSessionBatch(context.env, write, context.req.raw.signal, background) },
                201,
            );
        })
        .get("/v2/projects/:projectId/runtimes/:runtimeId/sessions", (context) =>
            recordingSummaryResponse(context, "directory"),
        )
        .get("/v2/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId", (context) =>
            recordingSummaryResponse(context, "summary"),
        )
        .get(
            "/v1/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/execution",
            async (context): Promise<Response> => {
                const query = sessionQuery(context);
                if (query === null) {
                    return errorResponse("not_found", 404);
                }
                for (const commandId of context.req.queries("commandId") ?? []) {
                    query.append("commandId", commandId);
                }
                return await sessionRecordingFetch(context, query, "execution");
            },
        )
        .get(
            "/v1/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/turns",
            async (context): Promise<Response> => {
                const query = sessionQuery(context);
                if (query === null) {
                    return errorResponse("not_found", 404);
                }
                forwardQuery(context.req.query(), query, ["before", "limit"]);
                return await sessionRecordingFetch(context, query, "turns");
            },
        )
        .get(
            "/v1/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/turns/:commandId/items",
            async (context): Promise<Response> => {
                const query = sessionQuery(context);
                const commandId = decodedIdentifier(context.req.param("commandId"));
                if (query === null || commandId === null) {
                    return errorResponse("not_found", 404);
                }
                query.set("commandId", commandId);
                forwardQuery(context.req.query(), query, ["after", "before", "limit"]);
                return await sessionRecordingFetch(context, query, "turn-items");
            },
        )
        .get(
            "/v1/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/turns/:commandId/items/:itemId",
            async (context): Promise<Response> => {
                const query = sessionQuery(context);
                const commandId = decodedIdentifier(context.req.param("commandId"));
                const itemId = turnItemId(context.req.param("itemId"));
                if (query === null || commandId === null || itemId === null) {
                    return errorResponse("not_found", 404);
                }
                query.set("commandId", commandId);
                query.set("itemId", itemId);
                return await sessionRecordingFetch(context, query, "turn-item");
            },
        )
        .get(
            "/v1/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/events",
            async (context): Promise<Response> => {
                const query = sessionQuery(context);
                if (query === null) {
                    return errorResponse("not_found", 404);
                }
                const incremental = incrementalReadQuery(context.req.query());
                if (incremental !== null && "error" in incremental) {
                    return errorResponse("invalid_request", 400);
                }
                if (incremental !== null) {
                    if (incremental.after !== undefined) {
                        query.set("after", incremental.after);
                    }
                    query.set("limit", incremental.limit.toString());
                    if (incremental.waitMs !== undefined) {
                        query.set("waitMs", incremental.waitMs.toString());
                    }
                }
                return await sessionRecordingFetch(context, query, incremental === null ? "events" : "page-events");
            },
        )
        .all("*", (): Response => errorResponse("not_found", 404));
    return {
        fetch: async (request, environment, executionContext) =>
            await application.fetch(request, environment, executionContext),
    };
}

export class SessionRecordingDurableObject extends DurableObject<RecordingWorkerBindings> {
    readonly #history: SessionTurnHistory;
    readonly #routes: Hono<RecordingEnvironment>;
    constructor(state: DurableObjectState, _environment: RecordingWorkerBindings) {
        super(state, _environment);
        const metrics = new RecordingSqlMetrics();
        const recording = new SessionRecordingStorage(state.storage, metrics);
        const historyStorage = new SessionTurnHistoryStorage(state.storage, metrics);
        this.#history = new SessionTurnHistory(recording, historyStorage);
        this.#routes = sessionRecordingRoutes(
            recording,
            this.#history,
            this.#scheduleBackfill,
            metrics,
            new RecordingEventWaiters(),
        );
    }
    override async fetch(request: Request): Promise<Response> {
        return await this.#routes.fetch(request);
    }
    /** Folds one bounded step of unprojected Recording batches and keeps stepping until caught up. */
    override async alarm(): Promise<void> {
        const outcome = this.#history.backfill(new Date());
        switch (outcome.kind) {
            case "caught_up":
                return;
            case "behind":
                await this.ctx.storage.setAlarm(Date.now());
                return;
            case "failed":
                await this.ctx.storage.setAlarm(outcome.retryAt.getTime());
                return;
        }
    }
    /** Arms a backfill step at `at` (now by default) unless one is already scheduled. */
    readonly #scheduleBackfill = async (at?: Date): Promise<void> => {
        if ((await this.ctx.storage.getAlarm()) === null) {
            await this.ctx.storage.setAlarm(Math.max(Date.now(), at?.getTime() ?? 0));
        }
    };
}

export class RecordingDirectoryDurableObject extends DurableObject<RecordingWorkerBindings> {
    readonly #routes: Hono<RecordingEnvironment>;
    constructor(state: DurableObjectState, _environment: RecordingWorkerBindings) {
        super(state, _environment);
        const metrics = new RecordingSqlMetrics();
        const storage = new RecordingDirectoryStorage(state.storage, metrics);
        this.#routes = recordingDirectoryRoutes(storage, new RecordingDirectory(storage), metrics);
    }
    override async fetch(request: Request): Promise<Response> {
        return await this.#routes.fetch(request, this.env);
    }
}

export default createRecordingWorker();
