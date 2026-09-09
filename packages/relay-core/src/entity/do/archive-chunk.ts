export interface StoredArchiveChunk {
    readonly artifactId: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly storedByteLength: number;
}
