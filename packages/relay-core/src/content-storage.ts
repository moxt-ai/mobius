export class ContentStorageError extends Error {
  readonly code:
    | "content_conflict"
    | "content_not_found"
    | "content_storage_timeout"
    | "content_storage_unavailable";

  constructor(
    code: ContentStorageError["code"],
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.code = code;
    this.name = "ContentStorageError";
  }
}

export class ContentTarget {
  readonly artifactId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly tenantId: string;

  constructor(
    tenantId: string,
    projectId: string,
    sessionId: string,
    artifactId: string,
  ) {
    this.artifactId = artifactId;
    this.projectId = projectId;
    this.sessionId = sessionId;
    this.tenantId = tenantId;
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
  readonly delete: (
    target: ContentTarget,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly inspect: (
    target: ContentTarget,
    signal: AbortSignal,
  ) => Promise<ContentInspection>;
  readonly read: (
    target: ContentTarget,
    signal: AbortSignal,
  ) => Promise<ImmutableContent>;
  readonly write: (
    target: ContentTarget,
    content: ImmutableContent,
    signal: AbortSignal,
  ) => Promise<void>;
}
