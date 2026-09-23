const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Cloudflare Durable Object SQLite limits a value to 2 MiB. Keep the same
// 1.5 MiB content-row budget used by Agents Sessions so metadata never makes
// a durable transcript row exceed that limit.
export const SESSION_TEXT_CHUNK_BYTE_LIMIT = 1_536 * 1_024;

export function utf8ByteLength(value: string): number {
    return encoder.encode(value).byteLength;
}

export function splitUtf8Text(value: string, byteLimit = SESSION_TEXT_CHUNK_BYTE_LIMIT): readonly string[] {
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 4) {
        throw new RangeError("The session text chunk byte limit is invalid");
    }
    const bytes = encoder.encode(value);
    if (bytes.byteLength === 0) {
        return [""];
    }
    const chunks: string[] = [];
    let start = 0;
    while (start < bytes.byteLength) {
        let end = Math.min(start + byteLimit, bytes.byteLength);
        while (end < bytes.byteLength && end > start) {
            const nextByte = bytes[end];
            if (nextByte === undefined || (nextByte & 0b1100_0000) !== 0b1000_0000) {
                break;
            }
            end -= 1;
        }
        if (end === start) {
            throw new RangeError("The session text chunk byte limit splits a UTF-8 code point");
        }
        chunks.push(decoder.decode(bytes.subarray(start, end)));
        start = end;
    }
    return chunks;
}
