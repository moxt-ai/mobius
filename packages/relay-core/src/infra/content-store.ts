export class ContentStorageError extends Error {
    readonly code: "content_conflict" | "content_not_found" | "content_storage_timeout" | "content_storage_unavailable";

    constructor(code: ContentStorageError["code"], message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "ContentStorageError";
    }
}

export class ContentQuotaExceededError extends Error {
    readonly code = "content_quota_exceeded";
    readonly limitBytes: number;

    constructor(limitBytes: number) {
        super("The immutable content quota is exhausted");
        this.limitBytes = limitBytes;
        this.name = "ContentQuotaExceededError";
    }
}

export class ContentTarget {
    readonly artifactId: string;
    readonly projectId: string;
    readonly sessionId: string;

    constructor(projectId: string, sessionId: string, artifactId: string) {
        this.artifactId = artifactId;
        this.projectId = projectId;
        this.sessionId = sessionId;
    }
}

export interface ImmutableContent {
    readonly bytes: Uint8Array;
    readonly contentEncoding: "gzip" | "identity";
    readonly mediaType: string;
    readonly sha256: string;
}

export type ContentInspection =
    | {
          readonly kind: "available";
          readonly byteLength: number;
          readonly contentEncoding: "gzip" | "identity";
          readonly mediaType: string;
          readonly sha256: string;
      }
    | { readonly kind: "missing" };

export interface ImmutableContentStore {
    readonly delete: (target: ContentTarget, signal: AbortSignal) => Promise<void>;
    readonly inspect: (target: ContentTarget, signal: AbortSignal) => Promise<ContentInspection>;
    readonly read: (target: ContentTarget, signal: AbortSignal) => Promise<ImmutableContent>;
    readonly write: (target: ContentTarget, content: ImmutableContent, signal: AbortSignal) => Promise<void>;
}

export type ContentWriteResult =
    | { readonly kind: "inserted" }
    | { readonly kind: "quota-exceeded"; readonly limitBytes: number }
    | { readonly kind: "existing"; readonly metadata: Extract<ContentInspection, { readonly kind: "available" }> };

export interface ContentPersistence {
    readonly delete: ImmutableContentStore["delete"];
    readonly inspect: ImmutableContentStore["inspect"];
    readonly read: ImmutableContentStore["read"];
    readonly insert: (
        target: ContentTarget,
        content: ImmutableContent,
        byteLimit: number | null,
        signal: AbortSignal,
    ) => Promise<ContentWriteResult>;
}
