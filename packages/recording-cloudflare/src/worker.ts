import { DurableObject } from "cloudflare:workers";
import {
    decodeRecordedSessionEvent,
    decodeSessionRecordingHistory,
    decodeSessionRecordingWrite,
    encodeSessionRecordingDirectory,
    encodeSessionRecordingHistory,
    isIdentifier,
    ProtocolMessageError,
    type RecordedSessionEvent,
    type SessionRecordingHistory,
    type SessionRecordingSegment,
    type SessionRecordingWrite,
    validateSessionEventEnvelope,
} from "@moxt-ai/mobius-protocol";
import { RecordingDirectoryStorage } from "./storage/recording-directory-storage.ts";
import { SessionRecordingStorage } from "./storage/session-recording-storage.ts";

export interface RecordingWorkerBindings {
    readonly RECORDING_DIRECTORY: DurableObjectNamespace<RecordingDirectoryDurableObject>;
    readonly SESSION_RECORDING: DurableObjectNamespace<SessionRecordingDurableObject>;
}

export interface RecordingWorker {
    readonly fetch: (request: Request, environment: RecordingWorkerBindings) => Promise<Response>;
}

type RecordingPath = {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
};

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status });
}

function recordingPath(pathname: string): RecordingPath | null {
    const match = pathname.match(/^\/v1\/projects\/([^/]+)\/runtimes\/([^/]+)\/sessions\/([^/]+)\/events$/u);
    if (match === null) {
        return null;
    }
    let projectId: string;
    let runtimeId: string;
    let sessionId: string;
    try {
        projectId = decodeURIComponent(match[1] ?? "");
        runtimeId = decodeURIComponent(match[2] ?? "");
        sessionId = decodeURIComponent(match[3] ?? "");
    } catch {
        return null;
    }
    if (
        projectId === undefined ||
        runtimeId === undefined ||
        sessionId === undefined ||
        !isIdentifier(projectId) ||
        !isIdentifier(runtimeId) ||
        !isIdentifier(sessionId)
    ) {
        return null;
    }
    return { projectId, runtimeId, sessionId };
}

function objectName(target: RecordingPath): string {
    return JSON.stringify([target.projectId, target.sessionId]);
}

function directoryObjectName(target: Pick<RecordingPath, "projectId" | "runtimeId">): string {
    return JSON.stringify([target.projectId, target.runtimeId]);
}

function directoryPath(pathname: string): Pick<RecordingPath, "projectId" | "runtimeId"> | null {
    const match = pathname.match(/^\/v1\/projects\/([^/]+)\/runtimes\/([^/]+)\/sessions$/u);
    if (match === null) {
        return null;
    }
    let projectId: string;
    let runtimeId: string;
    try {
        projectId = decodeURIComponent(match[1] ?? "");
        runtimeId = decodeURIComponent(match[2] ?? "");
    } catch {
        return null;
    }
    return isIdentifier(projectId) && isIdentifier(runtimeId) ? { projectId, runtimeId } : null;
}

type RecordingDirectoryEvent = Extract<
    RecordedSessionEvent,
    {
        readonly kind: "session.completed" | "session.failed" | "session.forked" | "session.ready" | "session.started";
    }
>;

interface ValidatedSessionRecordingWrite {
    readonly event: RecordedSessionEvent;
    readonly write: SessionRecordingWrite;
}

function decodeValidatedWrite(encoded: string): ValidatedSessionRecordingWrite {
    const write = decodeSessionRecordingWrite(encoded);
    return { event: validateSessionEventEnvelope(write.envelope), write };
}

function isRecordingDirectoryEvent(event: RecordedSessionEvent): event is RecordingDirectoryEvent {
    switch (event.kind) {
        case "session.completed":
        case "session.failed":
        case "session.forked":
        case "session.ready":
        case "session.started":
            return true;
        case "agent.activity":
        case "agent.activity.narration":
        case "agent.content":
        case "agent.message.delta":
        case "session.commands.updated":
        case "session.config.updated":
        case "session.elicitation.requested":
        case "session.elicitation.resolved":
        case "session.info.updated":
        case "session.permission.requested":
        case "session.permission.resolved":
        case "session.queue.changed":
        case "session.usage.updated":
            return false;
        default: {
            const unsupported: never = event;
            return unsupported;
        }
    }
}

function decodeLineage(encoded: string | null): readonly string[] | null {
    if (encoded === null) {
        return [];
    }
    try {
        const value: unknown = JSON.parse(encoded);
        return Array.isArray(value) && value.length <= 32 && value.every(isIdentifier) ? value : null;
    } catch {
        return null;
    }
}

function truncateSegments(
    segments: readonly SessionRecordingSegment[],
    throughCommandId: string,
): readonly SessionRecordingSegment[] | null {
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex];
        if (segment === undefined) {
            continue;
        }
        for (let entryIndex = 0; entryIndex < segment.entries.length; entryIndex += 1) {
            const entry = segment.entries[entryIndex];
            if (entry === undefined) {
                continue;
            }
            const event = decodeRecordedSessionEvent(entry.envelope.payload);
            if (
                (event.kind === "session.completed" || event.kind === "session.failed") &&
                event.commandId === throughCommandId
            ) {
                return [
                    ...segments.slice(0, segmentIndex),
                    {
                        ...segment,
                        entries: segment.entries.slice(0, entryIndex + 1),
                        throughCommandId,
                    },
                ];
            }
        }
    }
    return null;
}

export function createRecordingWorker(): RecordingWorker {
    return {
        fetch: async (request, environment) => {
            const url = new URL(request.url);
            if (request.method === "POST" && url.pathname === "/v1/session-events") {
                let encoded: string;
                try {
                    encoded = await request.text();
                } catch {
                    return errorResponse("invalid_envelope", "The Recording envelope is invalid", 400);
                }
                let validated: ValidatedSessionRecordingWrite;
                try {
                    validated = decodeValidatedWrite(encoded);
                } catch (cause) {
                    if (cause instanceof ProtocolMessageError) {
                        return errorResponse("invalid_envelope", "The Recording envelope is invalid", 400);
                    }
                    throw cause;
                }
                const { event, write } = validated;
                const target = {
                    projectId: write.projectId,
                    runtimeId: write.runtimeId,
                    sessionId: write.envelope.sessionId,
                };
                let sourceRecordingEpoch: string | null = null;
                if (event.kind === "session.forked") {
                    if (event.sourceSessionId === event.sessionId) {
                        return errorResponse("invalid_fork_origin", "A Session cannot fork from itself", 409);
                    }
                    const sourceTarget = { ...target, sessionId: event.sourceSessionId };
                    const source = await environment.SESSION_RECORDING.getByName(objectName(sourceTarget)).fetch(
                        new Request(
                            `https://session-recording.internal/events?projectId=${encodeURIComponent(sourceTarget.projectId)}&runtimeId=${encodeURIComponent(sourceTarget.runtimeId)}&sessionId=${encodeURIComponent(sourceTarget.sessionId)}&throughCommandId=${encodeURIComponent(event.throughCommandId)}`,
                            { signal: request.signal },
                        ),
                    );
                    if (source.status === 404) {
                        return errorResponse("fork_source_not_ready", "The fork source is not recorded yet", 503);
                    }
                    if (!source.ok) {
                        return source;
                    }
                    let sourceHistory: SessionRecordingHistory;
                    try {
                        sourceHistory = decodeSessionRecordingHistory(await source.text());
                    } catch {
                        return errorResponse("storage_unavailable", "Recording storage is unavailable", 503);
                    }
                    if (sourceHistory.segments.some((segment) => segment.sessionId === event.sessionId)) {
                        return errorResponse("invalid_fork_origin", "The fork lineage contains a cycle", 409);
                    }
                    sourceRecordingEpoch = source.headers.get("x-mobius-recording-epoch");
                    if (sourceRecordingEpoch === null || !isIdentifier(sourceRecordingEpoch)) {
                        return errorResponse("storage_unavailable", "Recording storage is unavailable", 503);
                    }
                }
                const recorded = await environment.SESSION_RECORDING.getByName(objectName(target)).fetch(
                    new Request("https://session-recording.internal/events", {
                        body: encoded,
                        headers: {
                            "content-type": "application/json",
                            ...(sourceRecordingEpoch === null
                                ? {}
                                : { "x-mobius-source-recording-epoch": sourceRecordingEpoch }),
                        },
                        method: "POST",
                        signal: request.signal,
                    }),
                );
                if (recorded.status !== 200 && recorded.status !== 201) {
                    return recorded;
                }
                const result: unknown = await recorded.json();
                if (typeof result !== "object" || result === null || Array.isArray(result)) {
                    return errorResponse("storage_unavailable", "Recording storage is unavailable", 503);
                }
                const recordingEpoch = Reflect.get(result, "recordingEpoch");
                const recordedAt = Reflect.get(result, "recordedAt");
                if (
                    typeof recordingEpoch !== "string" ||
                    !isIdentifier(recordingEpoch) ||
                    typeof recordedAt !== "number" ||
                    !Number.isSafeInteger(recordedAt) ||
                    recordedAt < 0
                ) {
                    return errorResponse("storage_unavailable", "Recording storage is unavailable", 503);
                }
                if (!isRecordingDirectoryEvent(event)) {
                    return Response.json({ recordingEpoch }, { status: recorded.status });
                }
                const indexed = await environment.RECORDING_DIRECTORY.getByName(directoryObjectName(target)).fetch(
                    new Request("https://recording-directory.internal/events", {
                        body: encoded,
                        headers: {
                            "content-type": "application/json",
                            "x-mobius-recorded-at": recordedAt.toString(),
                        },
                        method: "POST",
                        signal: request.signal,
                    }),
                );
                if (indexed.status !== 204) {
                    return errorResponse("storage_unavailable", "Recording directory is unavailable", 503);
                }
                return Response.json({ recordingEpoch }, { status: recorded.status });
            }
            const directory = directoryPath(url.pathname);
            if (request.method === "GET" && directory !== null) {
                return await environment.RECORDING_DIRECTORY.getByName(directoryObjectName(directory)).fetch(
                    new Request(
                        `https://recording-directory.internal/sessions?runtimeId=${encodeURIComponent(directory.runtimeId)}`,
                        { signal: request.signal },
                    ),
                );
            }
            const target = recordingPath(url.pathname);
            if (request.method === "GET" && target !== null) {
                return await environment.SESSION_RECORDING.getByName(objectName(target)).fetch(
                    new Request(
                        `https://session-recording.internal/events?projectId=${encodeURIComponent(target.projectId)}&runtimeId=${encodeURIComponent(target.runtimeId)}&sessionId=${encodeURIComponent(target.sessionId)}`,
                        { signal: request.signal },
                    ),
                );
            }
            return errorResponse("not_found", "The Recording route is unavailable", 404);
        },
    };
}

export class SessionRecordingDurableObject extends DurableObject<RecordingWorkerBindings> {
    readonly #environment: RecordingWorkerBindings;
    readonly #recordings: SessionRecordingStorage;

    constructor(state: DurableObjectState, environment: RecordingWorkerBindings) {
        super(state, environment);
        this.#environment = environment;
        this.#recordings = new SessionRecordingStorage(state.storage);
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/events") {
            let validated: ValidatedSessionRecordingWrite;
            try {
                validated = decodeValidatedWrite(await request.text());
            } catch {
                return errorResponse("invalid_envelope", "The Recording envelope is invalid", 400);
            }
            const sourceRecordingEpoch = request.headers.get("x-mobius-source-recording-epoch");
            const forkOrigin =
                validated.event.kind === "session.forked" &&
                sourceRecordingEpoch !== null &&
                isIdentifier(sourceRecordingEpoch)
                    ? {
                          createdAt: Date.now(),
                          sourceRecordingEpoch,
                          sourceSessionId: validated.event.sourceSessionId,
                          throughCommandId: validated.event.throughCommandId,
                      }
                    : null;
            const claim = this.#recordings.claim(validated.write, validated.event, Date.now(), forkOrigin);
            if (claim.kind === "conflict") {
                return errorResponse("idempotency_conflict", "The event identifier is already recorded", 409);
            }
            return Response.json(
                { recordedAt: claim.recordedAt, recordingEpoch: claim.recordingEpoch },
                { status: claim.kind === "accepted" ? 201 : 200 },
            );
        }
        if (request.method === "GET" && url.pathname === "/events") {
            const projectId = url.searchParams.get("projectId") ?? "";
            const runtimeId = url.searchParams.get("runtimeId") ?? "";
            const sessionId = url.searchParams.get("sessionId") ?? "";
            if (!isIdentifier(projectId) || !isIdentifier(runtimeId) || !isIdentifier(sessionId)) {
                return errorResponse("invalid_target", "The Recording target is invalid", 400);
            }
            const history = this.#recordings.read(projectId, runtimeId, sessionId);
            if (history === null) {
                return errorResponse("recording_not_found", "The Session recording is unavailable", 404);
            }
            const lineage = decodeLineage(request.headers.get("x-mobius-recording-lineage"));
            if (lineage === null || lineage.includes(sessionId) || lineage.length >= 32) {
                return errorResponse("invalid_fork_origin", "The fork lineage is invalid", 409);
            }
            let segments: readonly SessionRecordingSegment[] = [];
            if (history.origin !== null) {
                const sourceTarget = { projectId, runtimeId, sessionId: history.origin.sourceSessionId };
                const source = await this.#environment.SESSION_RECORDING.getByName(objectName(sourceTarget)).fetch(
                    new Request(
                        `https://session-recording.internal/events?projectId=${encodeURIComponent(projectId)}&runtimeId=${encodeURIComponent(runtimeId)}&sessionId=${encodeURIComponent(history.origin.sourceSessionId)}&throughCommandId=${encodeURIComponent(history.origin.throughCommandId)}`,
                        {
                            headers: { "x-mobius-recording-lineage": JSON.stringify([...lineage, sessionId]) },
                            signal: request.signal,
                        },
                    ),
                );
                if (!source.ok) {
                    return source;
                }
                const sourceEpoch = source.headers.get("x-mobius-recording-epoch");
                if (sourceEpoch !== history.origin.sourceRecordingEpoch) {
                    return errorResponse("fork_source_changed", "The fork source Recording changed", 409);
                }
                try {
                    segments = decodeSessionRecordingHistory(await source.text()).segments;
                } catch {
                    return errorResponse("storage_unavailable", "Recording storage is unavailable", 503);
                }
            }
            const complete = [
                ...segments,
                {
                    entries: history.entries,
                    recordingEpoch: history.recordingEpoch,
                    sessionId,
                    throughCommandId: null,
                },
            ];
            const throughCommandId = url.searchParams.get("throughCommandId");
            const resolved =
                throughCommandId === null
                    ? complete
                    : isIdentifier(throughCommandId)
                      ? truncateSegments(complete, throughCommandId)
                      : null;
            if (resolved === null) {
                return errorResponse("fork_source_not_ready", "The fork source Turn is not terminal", 404);
            }
            return new Response(encodeSessionRecordingHistory({ segments: resolved, sessionId }), {
                headers: {
                    "cache-control": "no-store",
                    "content-type": "application/json",
                    "x-mobius-recording-epoch": history.recordingEpoch,
                },
            });
        }
        return errorResponse("not_found", "The Session Recording route is unavailable", 404);
    }
}

export class RecordingDirectoryDurableObject extends DurableObject<RecordingWorkerBindings> {
    readonly #directory: RecordingDirectoryStorage;

    constructor(state: DurableObjectState, environment: RecordingWorkerBindings) {
        super(state, environment);
        this.#directory = new RecordingDirectoryStorage(state.storage);
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/events") {
            const recordedAt = Number(request.headers.get("x-mobius-recorded-at"));
            if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) {
                return errorResponse("invalid_envelope", "The Recording envelope is invalid", 400);
            }
            let validated: ValidatedSessionRecordingWrite;
            try {
                validated = decodeValidatedWrite(await request.text());
            } catch {
                return errorResponse("invalid_envelope", "The Recording envelope is invalid", 400);
            }
            if (!isRecordingDirectoryEvent(validated.event)) {
                return new Response(null, { status: 204 });
            }
            this.#directory.record(validated.write, validated.event, recordedAt);
            return new Response(null, { status: 204 });
        }
        if (request.method === "GET" && url.pathname === "/sessions") {
            const runtimeId = url.searchParams.get("runtimeId") ?? "";
            if (!isIdentifier(runtimeId)) {
                return errorResponse("invalid_target", "The Recording target is invalid", 400);
            }
            return new Response(encodeSessionRecordingDirectory(this.#directory.read(runtimeId)), {
                headers: { "cache-control": "no-store", "content-type": "application/json" },
            });
        }
        return errorResponse("not_found", "The Recording Directory route is unavailable", 404);
    }
}

const worker: ExportedHandler<RecordingWorkerBindings> = createRecordingWorker();
export default worker;
