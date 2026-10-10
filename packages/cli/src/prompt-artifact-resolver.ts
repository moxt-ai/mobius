import { createHash } from "node:crypto";

import { isIdentifier, type PromptImage, type PromptResource } from "@moxt-ai/mobius-protocol";
import { fetch } from "undici";

import type { DaemonConfig } from "./config.ts";
import { relayDispatcher } from "./network/environment-proxy.ts";
import { relayHttpEndpoint, runtimeAuthorization } from "./relay-connection/runtime-authentication.ts";

const ARTIFACT_SCHEME = "mobius-artifact:";
const ARTIFACT_DOWNLOAD_TIMEOUT_MILLISECONDS = 20_000;
const MAX_AGENT_IMAGE_BASE64_LENGTH = 4_000_000;
const MAX_AGENT_RESOURCE_BYTE_LENGTH = 1_000_000;

export class PromptArtifactError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PromptArtifactError";
    }
}

export class ResolvedPromptArtifacts {
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];

    constructor(images: readonly PromptImage[], resources: readonly PromptResource[]) {
        this.images = images;
        this.resources = resources;
    }
}

export interface ArtifactPromptCommand {
    readonly commandId: string;
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
    readonly sessionId: string;
}

class PromptArtifactReference {
    readonly artifactId: string;
    readonly byteLength: number;
    readonly resource: PromptResource;
    readonly sha256: string;

    constructor(artifactId: string, byteLength: number, sha256: string, resource: PromptResource) {
        this.artifactId = artifactId;
        this.byteLength = byteLength;
        this.resource = resource;
        this.sha256 = sha256;
    }
}

function parseReference(resource: PromptResource): PromptArtifactReference {
    let url: URL;
    try {
        url = new URL(resource.uri);
    } catch (cause) {
        throw new PromptArtifactError("artifact_reference_invalid", "The prompt artifact reference is invalid", {
            cause,
        });
    }
    const keys = [...url.searchParams.keys()].sort();
    const artifactId = url.pathname;
    const encodedByteLength = url.searchParams.get("byteLength") ?? "";
    const sha256 = url.searchParams.get("sha256") ?? "";
    const byteLength = Number(encodedByteLength);
    if (
        url.protocol !== ARTIFACT_SCHEME ||
        url.hash.length > 0 ||
        resource.type !== "link" ||
        resource.text.length > 0 ||
        !isIdentifier(artifactId) ||
        keys.length !== 2 ||
        keys[0] !== "byteLength" ||
        keys[1] !== "sha256" ||
        !/^[1-9][0-9]*$/.test(encodedByteLength) ||
        !Number.isSafeInteger(byteLength) ||
        !/^[a-f0-9]{64}$/.test(sha256)
    ) {
        throw new PromptArtifactError("artifact_reference_invalid", "The prompt artifact reference is invalid");
    }
    return new PromptArtifactReference(artifactId, byteLength, sha256, resource);
}

function downloadUrl(config: DaemonConfig, command: ArtifactPromptCommand, reference: PromptArtifactReference): URL {
    const url = relayHttpEndpoint(config.relayUrl);
    let channelPath = "";
    if (url.pathname.endsWith("/daemon")) {
        channelPath = url.pathname.slice(0, -"/daemon".length);
    } else {
        const runtimePath = "/v1/runtimes/connect";
        if (!url.pathname.endsWith(runtimePath)) {
            throw new PromptArtifactError("artifact_endpoint_invalid", "The Relay artifact endpoint is invalid");
        }
        channelPath = `${url.pathname.slice(0, -runtimePath.length)}/channels/${encodeURIComponent(config.channelId)}`;
    }
    url.pathname = `${channelPath}/sessions/${encodeURIComponent(command.sessionId)}/commands/${encodeURIComponent(command.commandId)}/artifacts/${encodeURIComponent(reference.artifactId)}/content`;
    return url;
}

async function responseBytes(
    response: Awaited<ReturnType<typeof fetch>>,
    expectedByteLength: number,
    signal: AbortSignal,
): Promise<Uint8Array> {
    const declaredLength = response.headers.get("content-length") ?? "";
    if (
        !/^(0|[1-9][0-9]*)$/.test(declaredLength) ||
        Number(declaredLength) !== expectedByteLength ||
        response.body === null
    ) {
        throw new PromptArtifactError("artifact_integrity_failed", "The prompt artifact failed integrity validation");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) {
                break;
            }
            byteLength += chunk.value.byteLength;
            if (byteLength > expectedByteLength) {
                await reader.cancel("Artifact response exceeded its authorization");
                throw new PromptArtifactError(
                    "artifact_integrity_failed",
                    "The prompt artifact failed integrity validation",
                );
            }
            chunks.push(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }
    if (byteLength !== expectedByteLength) {
        throw new PromptArtifactError("artifact_integrity_failed", "The prompt artifact failed integrity validation");
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function download(
    config: DaemonConfig,
    command: ArtifactPromptCommand,
    reference: PromptArtifactReference,
    signal: AbortSignal,
): Promise<Uint8Array> {
    signal.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MILLISECONDS);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
        response = await fetch(downloadUrl(config, command, reference), {
            dispatcher: relayDispatcher(config.relayProxy),
            headers: {
                accept: reference.resource.mimeType,
                "accept-encoding": "identity",
                ...runtimeAuthorization(config.relayUrl),
            },
            signal: requestSignal,
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new PromptArtifactError(
                "artifact_download_rejected",
                "The Relay rejected the prompt artifact download",
            );
        }
        if (
            response.headers.get("content-type") !== reference.resource.mimeType ||
            response.headers.get("x-mobius-artifact-id") !== reference.artifactId ||
            response.headers.get("x-mobius-sha256") !== reference.sha256
        ) {
            await response.body?.cancel();
            throw new PromptArtifactError(
                "artifact_integrity_failed",
                "The prompt artifact failed integrity validation",
            );
        }
        const bytes = await responseBytes(response, reference.byteLength, requestSignal);
        if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
            throw new PromptArtifactError(
                "artifact_integrity_failed",
                "The prompt artifact failed integrity validation",
            );
        }
        return bytes;
    } catch (error) {
        signal.throwIfAborted();
        if (error instanceof PromptArtifactError) {
            throw error;
        }
        throw new PromptArtifactError(
            timeoutSignal.aborted ? "artifact_download_timeout" : "artifact_download_failed",
            timeoutSignal.aborted
                ? "The prompt artifact download timed out"
                : "The prompt artifact could not be downloaded",
            { cause: error },
        );
    }
}

function isTextMediaType(mediaType: string): boolean {
    return (
        mediaType.startsWith("text/") ||
        mediaType === "application/json" ||
        mediaType.endsWith("+json") ||
        mediaType === "application/xml" ||
        mediaType.endsWith("+xml")
    );
}

export async function resolvePromptArtifacts(
    config: DaemonConfig,
    command: ArtifactPromptCommand,
    signal: AbortSignal,
): Promise<ResolvedPromptArtifacts> {
    const images = [...command.images];
    const resources: PromptResource[] = [];
    for (const resource of command.resources) {
        signal.throwIfAborted();
        if (!resource.uri.startsWith(ARTIFACT_SCHEME)) {
            resources.push(resource);
            continue;
        }
        const reference = parseReference(resource);
        const bytes = await download(config, command, reference, signal);
        if (resource.mimeType.startsWith("image/")) {
            const data = Buffer.from(bytes).toString("base64");
            if (data.length > MAX_AGENT_IMAGE_BASE64_LENGTH || images.length >= 8) {
                throw new PromptArtifactError(
                    "artifact_too_large_for_agent",
                    "The prompt artifact exceeds the Agent image limit",
                );
            }
            images.push({ data, mimeType: resource.mimeType, name: resource.name });
            continue;
        }
        if (!isTextMediaType(resource.mimeType)) {
            throw new PromptArtifactError(
                "artifact_media_type_unsupported",
                "The Agent cannot consume this prompt artifact media type",
            );
        }
        if (bytes.byteLength > MAX_AGENT_RESOURCE_BYTE_LENGTH || resources.length >= 16) {
            throw new PromptArtifactError(
                "artifact_too_large_for_agent",
                "The prompt artifact exceeds the Agent resource limit",
            );
        }
        let text: string;
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (cause) {
            throw new PromptArtifactError("artifact_encoding_invalid", "The prompt artifact is not valid UTF-8 text", {
                cause,
            });
        }
        resources.push({
            mimeType: resource.mimeType,
            name: resource.name,
            text,
            type: "embedded",
            uri: resource.uri,
        });
    }
    return new ResolvedPromptArtifacts(images, resources);
}
