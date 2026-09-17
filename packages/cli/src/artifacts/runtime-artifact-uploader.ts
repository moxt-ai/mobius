import { createHash } from "node:crypto";
import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import {
    decodeMobiusArtifactUpload,
    decodeMobiusAvailableArtifact,
    type MobiusArtifactUpload,
    MobiusArtifactUploadRequest,
    MobiusProtocolError,
    MobiusValidationError,
} from "@moxt-ai/mobius-sdk";
import { fetch, type Response } from "undici";
import type { LocalArtifact } from "../authorization/local-artifact.ts";
import type { DaemonConfig } from "../config.ts";
import { environmentProxyDispatcher } from "../network/environment-proxy.ts";
import { runtimeAuthorization } from "../relay-connection/runtime-authentication.ts";

const UPLOAD_TIMEOUT_MILLISECONDS = 20_000;

class RuntimeArtifactUploadError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "RuntimeArtifactUploadError";
    }
}

export class UploadedRuntimeArtifact {
    readonly artifactId: string;
    readonly byteLength: number;
    readonly mimeType: string;
    readonly name: string;
    readonly sha256: string;

    constructor(artifactId: string, name: string, mimeType: string, byteLength: number, sha256: string) {
        this.artifactId = artifactId;
        this.byteLength = byteLength;
        this.mimeType = mimeType;
        this.name = name;
        this.sha256 = sha256;
    }
}

function channelOrigin(config: DaemonConfig): URL {
    const url = new URL(config.relayUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    let channelPath = "";
    if (url.pathname.endsWith("/daemon")) {
        channelPath = url.pathname.slice(0, -"/daemon".length);
    } else {
        const runtimePath = `${MOBIUS_API_PREFIX}/v1/runtimes/connect`;
        if (!url.pathname.endsWith("/v1/runtimes/connect") && !url.pathname.endsWith(runtimePath)) {
            throw new RuntimeArtifactUploadError("artifact_endpoint_invalid", "The Relay artifact endpoint is invalid");
        }
        channelPath = `${url.pathname.replace(/\/v1\/runtimes\/connect$/, "")}/channels/${encodeURIComponent(config.channelId)}`;
    }
    url.pathname = channelPath;
    url.search = "";
    url.hash = "";
    return url;
}

function uploadError(code: string, message: string, cause?: unknown): RuntimeArtifactUploadError {
    return new RuntimeArtifactUploadError(code, message, cause === undefined ? {} : { cause });
}

function translateSdkError(cause: unknown): never {
    if (cause instanceof MobiusValidationError) {
        throw uploadError("artifact_upload_failed", cause.message, cause);
    }
    if (cause instanceof MobiusProtocolError) {
        throw uploadError("artifact_upload_failed", "The Relay returned an invalid upload response", cause);
    }
    throw cause;
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch (cause) {
        throw uploadError("artifact_upload_failed", "The Relay returned an invalid upload response", cause);
    }
}

async function readAuthorization(response: Response): Promise<MobiusArtifactUpload> {
    try {
        return decodeMobiusArtifactUpload(await readJson(response));
    } catch (cause) {
        translateSdkError(cause);
    }
}

function sessionArtifactUrl(origin: URL, sessionId: string, resourcePath: string): URL {
    return new URL(`${origin.pathname}/sessions/${encodeURIComponent(sessionId)}/${resourcePath}`, origin);
}

async function postLease(
    url: URL,
    headers: Readonly<Record<string, string>>,
    request: MobiusArtifactUploadRequest,
    signal: AbortSignal,
): Promise<Response> {
    return await fetch(url, {
        dispatcher: environmentProxyDispatcher,
        headers: { ...headers, "content-type": "application/json" },
        method: "POST",
        body: JSON.stringify(request),
        signal,
    });
}

async function putContent(
    url: URL,
    headers: Readonly<Record<string, string>>,
    authorization: MobiusArtifactUpload,
    bytes: Uint8Array,
    signal: AbortSignal,
): Promise<Response> {
    return await fetch(url, {
        dispatcher: environmentProxyDispatcher,
        headers: {
            ...headers,
            "content-type": authorization.mediaType,
            "x-mobius-upload-token": authorization.uploadToken,
        },
        method: "PUT",
        body: bytes,
        signal,
    });
}

export async function uploadRuntimeArtifact(
    config: DaemonConfig,
    sessionId: string,
    artifact: LocalArtifact,
    signal: AbortSignal,
): Promise<UploadedRuntimeArtifact> {
    signal.throwIfAborted();
    let request: MobiusArtifactUploadRequest;
    try {
        request = new MobiusArtifactUploadRequest(
            artifact.name,
            artifact.mimeType,
            artifact.bytes.byteLength,
            createHash("sha256").update(artifact.bytes).digest("hex"),
        );
    } catch (cause) {
        translateSdkError(cause);
    }
    const timeoutSignal = AbortSignal.timeout(UPLOAD_TIMEOUT_MILLISECONDS);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);
    const origin = channelOrigin(config);
    const headers = runtimeAuthorization(config.relayUrl);
    let created: Response;
    try {
        created = await postLease(
            sessionArtifactUrl(origin, sessionId, "artifacts/uploads"),
            headers,
            request,
            requestSignal,
        );
    } catch (cause) {
        signal.throwIfAborted();
        throw uploadError(
            timeoutSignal.aborted ? "artifact_upload_timeout" : "artifact_upload_failed",
            timeoutSignal.aborted
                ? "The artifact upload authorization timed out"
                : "The artifact upload could not start",
            cause,
        );
    }
    if (!created.ok) {
        await created.body?.cancel();
        throw uploadError("artifact_upload_rejected", "The Relay rejected the artifact upload");
    }
    const authorization = await readAuthorization(created);
    let uploaded: Response;
    try {
        uploaded = await putContent(
            sessionArtifactUrl(origin, sessionId, `artifacts/${encodeURIComponent(authorization.artifactId)}/content`),
            headers,
            authorization,
            artifact.bytes,
            requestSignal,
        );
    } catch (cause) {
        signal.throwIfAborted();
        throw uploadError(
            timeoutSignal.aborted ? "artifact_upload_timeout" : "artifact_upload_failed",
            timeoutSignal.aborted ? "The artifact upload timed out" : "The artifact content could not be uploaded",
            cause,
        );
    }
    if (!uploaded.ok) {
        await uploaded.body?.cancel();
        throw uploadError("artifact_upload_rejected", "The Relay rejected the artifact content");
    }
    try {
        const available = decodeMobiusAvailableArtifact(await readJson(uploaded));
        return new UploadedRuntimeArtifact(
            available.artifactId,
            available.name,
            available.mediaType,
            available.byteLength,
            available.sha256,
        );
    } catch (cause) {
        translateSdkError(cause);
    }
}
