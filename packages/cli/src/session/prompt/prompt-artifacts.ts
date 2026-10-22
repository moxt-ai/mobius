import { isIdentifier, type PromptImage, type PromptResource } from "@moxt-ai/mobius-sdk/protocol";
import { OperationError } from "../../infra/operation-error.ts";

const ARTIFACT_SCHEME = "mobius-artifact:";
const MAX_AGENT_IMAGE_BASE64_LENGTH = 4_000_000;
const MAX_AGENT_RESOURCE_BYTE_LENGTH = 1_000_000;

export class PromptArtifactError extends OperationError {
    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(code, message, options);
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

/** One prompt artifact to download, with the size and digest its reference authorizes. */
export interface PromptArtifactDownload {
    readonly artifactId: string;
    readonly byteLength: number;
    readonly commandId: string;
    readonly mimeType: string;
    readonly sessionId: string;
    readonly sha256: string;
}

/** Downloads an artifact and verifies it against its reference. The runtime supplies it. */
export type DownloadArtifact = (artifact: PromptArtifactDownload, signal: AbortSignal) => Promise<Uint8Array>;

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
    download: DownloadArtifact,
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
        const bytes = await download(
            {
                artifactId: reference.artifactId,
                byteLength: reference.byteLength,
                commandId: command.commandId,
                mimeType: reference.resource.mimeType,
                sessionId: command.sessionId,
                sha256: reference.sha256,
            },
            signal,
        );
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
