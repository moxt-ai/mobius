import { DurableObject } from "cloudflare:workers";
import {
    decodeSessionRecordingWrite,
    encodeSessionRecordingDirectory,
    encodeSessionRecordingHistory,
    isIdentifier,
    ProtocolMessageError,
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

function decodeValidatedWrite(encoded: string): SessionRecordingWrite {
    const write = decodeSessionRecordingWrite(encoded);
    validateSessionEventEnvelope(write.envelope);
    return write;
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
                let write: SessionRecordingWrite;
                try {
                    write = decodeValidatedWrite(encoded);
                } catch (cause) {
                    if (cause instanceof ProtocolMessageError) {
                        return errorResponse("invalid_envelope", "The Recording envelope is invalid", 400);
                    }
                    throw cause;
                }
                const target = {
                    projectId: write.projectId,
                    runtimeId: write.runtimeId,
                    sessionId: write.envelope.sessionId,
                };
                const recorded = await environment.SESSION_RECORDING.getByName(objectName(target)).fetch(
                    new Request("https://session-recording.internal/events", {
                        body: encoded,
                        headers: { "content-type": "application/json" },
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
    readonly #recordings: SessionRecordingStorage;

    constructor(state: DurableObjectState, environment: RecordingWorkerBindings) {
        super(state, environment);
        this.#recordings = new SessionRecordingStorage(state.storage);
    }

    override async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/events") {
            let write: SessionRecordingWrite;
            try {
                write = decodeValidatedWrite(await request.text());
            } catch {
                return errorResponse("invalid_envelope", "The Recording envelope is invalid", 400);
            }
            const claim = this.#recordings.claim(write, Date.now());
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
            return new Response(encodeSessionRecordingHistory(history), {
                headers: { "cache-control": "no-store", "content-type": "application/json" },
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
            let write: SessionRecordingWrite;
            try {
                write = decodeValidatedWrite(await request.text());
            } catch {
                return errorResponse("invalid_envelope", "The Recording envelope is invalid", 400);
            }
            this.#directory.record(write, recordedAt);
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
