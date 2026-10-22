import { createHash } from "node:crypto";
import { fetch } from "undici";
import { type PromptArtifactDownload, PromptArtifactError } from "../../session/prompt/prompt-artifacts.ts";
import { environmentProxyDispatcher } from "../../util/network/environment-proxy.ts";
import type { RuntimeConfig } from "../config.ts";
import { relayAuthorization, relayHttpEndpoint } from "./relay-authentication.ts";

const ARTIFACT_DOWNLOAD_TIMEOUT_MILLISECONDS = 20_000;

function downloadUrl(config: RuntimeConfig, artifact: PromptArtifactDownload): URL {
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
    url.pathname = `${channelPath}/sessions/${encodeURIComponent(artifact.sessionId)}/commands/${encodeURIComponent(artifact.commandId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/content`;
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

/** Downloads a prompt artifact from the relay and verifies it against the reference the prompt carried. */
export async function downloadPromptArtifact(
    config: RuntimeConfig,
    artifact: PromptArtifactDownload,
    signal: AbortSignal,
): Promise<Uint8Array> {
    signal.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MILLISECONDS);
    const requestSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
        response = await fetch(downloadUrl(config, artifact), {
            dispatcher: environmentProxyDispatcher,
            headers: {
                accept: artifact.mimeType,
                "accept-encoding": "identity",
                ...relayAuthorization(config.relayUrl),
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
            response.headers.get("content-type") !== artifact.mimeType ||
            response.headers.get("x-mobius-artifact-id") !== artifact.artifactId ||
            response.headers.get("x-mobius-sha256") !== artifact.sha256
        ) {
            await response.body?.cancel();
            throw new PromptArtifactError(
                "artifact_integrity_failed",
                "The prompt artifact failed integrity validation",
            );
        }
        const bytes = await responseBytes(response, artifact.byteLength, requestSignal);
        if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
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
