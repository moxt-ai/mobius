import type { PromptImage, PromptResource } from "@moxt-ai/mobius-sdk";

const IMAGE_BYTES_LIMIT = 2_500_000;
const RESOURCE_BYTES_LIMIT = 1_000_000;
const READ_TIMEOUT_MILLISECONDS = 15_000;

export abstract class ReadPromptAttachment {
    abstract readonly name: string;
}

export class ReadPromptImage extends ReadPromptAttachment {
    readonly image: PromptImage;
    readonly name: string;

    constructor(image: PromptImage) {
        super();
        this.image = image;
        this.name = image.name;
    }
}

export class ReadPromptResource extends ReadPromptAttachment {
    readonly name: string;
    readonly resource: PromptResource;

    constructor(resource: PromptResource) {
        super();
        this.name = resource.name;
        this.resource = resource;
    }
}

export class AttachmentReadError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "AttachmentReadError";
    }
}

function readBytes(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const timeout = window.setTimeout(() => {
            reader.abort();
            reject(new AttachmentReadError("attachment_timeout", `Timed out while reading ${file.name}.`));
        }, READ_TIMEOUT_MILLISECONDS);
        const cleanup = (): void => {
            window.clearTimeout(timeout);
            reader.removeEventListener("abort", handleAbort);
            reader.removeEventListener("error", handleError);
            reader.removeEventListener("load", handleLoad);
        };
        const handleAbort = (): void => {
            cleanup();
            reject(new AttachmentReadError("attachment_cancelled", `Reading ${file.name} was cancelled.`));
        };
        const handleError = (): void => {
            cleanup();
            reject(
                new AttachmentReadError("attachment_read_failed", `Could not read ${file.name}.`, {
                    cause: reader.error,
                }),
            );
        };
        const handleLoad = (): void => {
            const result = reader.result;
            cleanup();
            if (!(result instanceof ArrayBuffer)) {
                reject(
                    new AttachmentReadError("attachment_read_failed", `${file.name} did not contain readable bytes.`),
                );
                return;
            }
            resolve(result);
        };
        reader.addEventListener("abort", handleAbort, { once: true });
        reader.addEventListener("error", handleError, { once: true });
        reader.addEventListener("load", handleLoad, { once: true });
        reader.readAsArrayBuffer(file);
    });
}

function encodeBase64(bytes: Uint8Array): string {
    const chunks: string[] = [];
    const chunkSize = 24_576;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }
    return window.btoa(chunks.join(""));
}

function attachmentUri(name: string): string {
    return `attachment:///${encodeURIComponent(name.replaceAll("/", "_"))}`;
}

export async function readPromptAttachment(file: File): Promise<ReadPromptAttachment> {
    const image = file.type.startsWith("image/");
    const limit = image ? IMAGE_BYTES_LIMIT : RESOURCE_BYTES_LIMIT;
    if (file.size === 0 || file.size > limit) {
        throw new AttachmentReadError(
            "attachment_size_invalid",
            image ? "Images must be between 1 byte and 2.5 MB." : "Text resources must be between 1 byte and 1 MB.",
        );
    }
    const bytes = new Uint8Array(await readBytes(file));
    if (image) {
        if (!/^image\/(?:gif|jpeg|png|webp)$/.test(file.type)) {
            throw new AttachmentReadError(
                "attachment_type_unsupported",
                "Only PNG, JPEG, GIF, and WebP images are supported.",
            );
        }
        return new ReadPromptImage({
            data: encodeBase64(bytes),
            mimeType: file.type,
            name: file.name,
        });
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return new ReadPromptResource({
        mimeType: file.type.length > 0 ? file.type : "text/plain",
        name: file.name,
        text,
        type: "embedded",
        uri: attachmentUri(file.name),
    });
}
