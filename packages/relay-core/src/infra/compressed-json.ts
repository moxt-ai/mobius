/**
 * Large internal Durable Object pages (Session message pages in particular) are dominated by a few very
 * compressible text fields, so sending them verbatim spends most of the Worker's `messages-body` budget on
 * transferring and decoding bytes. These helpers wrap an internal JSON response in a gzip body and decode it
 * on the caller side, so both ends agree on the encoding explicitly instead of depending on transport
 * content negotiation.
 */
export const COMPRESSED_JSON_ENCODING = "gzip";

export interface CompressedJsonResponse {
    readonly body: Uint8Array;
    readonly contentEncoding: typeof COMPRESSED_JSON_ENCODING;
}

export async function compressJsonBody(value: unknown, signal: AbortSignal): Promise<CompressedJsonResponse> {
    signal.throwIfAborted();
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    const stream = new Blob([Uint8Array.from(encoded).buffer])
        .stream()
        .pipeThrough(new CompressionStream(COMPRESSED_JSON_ENCODING));
    const body = new Uint8Array(await new Response(stream).arrayBuffer());
    signal.throwIfAborted();
    return { body, contentEncoding: COMPRESSED_JSON_ENCODING };
}

/**
 * A gzip body can expand far beyond its own size, so decoding stops as soon as the result exceeds `byteLimit`
 * instead of trusting the compressed length to imply the decoded one.
 */
export async function decompressJsonBody(body: Uint8Array, byteLimit: number): Promise<unknown> {
    const stream = new Blob([Uint8Array.from(body).buffer])
        .stream()
        .pipeThrough(new DecompressionStream(COMPRESSED_JSON_ENCODING));
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of new Response(stream).body ?? []) {
        length += chunk.byteLength;
        if (length > byteLimit) {
            throw new Error("The compressed response expands beyond the accepted limit");
        }
        chunks.push(chunk);
    }
    const uncompressed = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        uncompressed.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(uncompressed));
}
