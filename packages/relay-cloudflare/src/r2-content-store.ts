import {
  type ContentInspection,
  ContentStorageError,
  type ContentTarget,
  type ImmutableContent,
  type ImmutableContentStore,
} from "@moxt-ai/mobius-relay-core";

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function unavailable(message: string, cause: unknown): ContentStorageError {
  if (cause instanceof ContentStorageError) {
    return cause;
  }
  return new ContentStorageError("content_storage_unavailable", message, {
    cause,
  });
}

function objectKey(target: ContentTarget): string {
  const fields = [
    target.tenantId,
    target.projectId,
    target.sessionId,
    target.artifactId,
  ];
  if (fields.some((field) => !SAFE_IDENTIFIER.test(field))) {
    throw new ContentStorageError(
      "content_not_found",
      "The content target is invalid",
    );
  }
  return fields.join("/");
}

function metadata(object: R2Object): {
  readonly contentEncoding: "gzip" | "identity";
  readonly mediaType: string;
  readonly sha256: string;
} {
  const contentEncoding = object.customMetadata?.["contentEncoding"];
  const mediaType = object.customMetadata?.["mediaType"];
  const sha256 = object.customMetadata?.["sha256"];
  if (
    (contentEncoding !== "gzip" && contentEncoding !== "identity") ||
    typeof mediaType !== "string" ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new ContentStorageError(
      "content_storage_unavailable",
      "The R2 content metadata is invalid",
    );
  }
  return { contentEncoding, mediaType, sha256 };
}

export class R2ContentStore implements ImmutableContentStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  readonly delete = async (
    target: ContentTarget,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    try {
      await this.#bucket.delete(objectKey(target));
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw unavailable("The R2 content could not be deleted", error);
    }
  };

  readonly inspect = async (
    target: ContentTarget,
    signal: AbortSignal,
  ): Promise<ContentInspection> => {
    signal.throwIfAborted();
    try {
      const object = await this.#bucket.head(objectKey(target));
      signal.throwIfAborted();
      if (object === null) {
        return { kind: "missing" };
      }
      const values = metadata(object);
      return {
        byteLength: object.size,
        contentEncoding: values.contentEncoding,
        kind: "available",
        mediaType: values.mediaType,
        sha256: values.sha256,
      };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw unavailable("The R2 content could not be inspected", error);
    }
  };

  readonly read = async (
    target: ContentTarget,
    signal: AbortSignal,
  ): Promise<ImmutableContent> => {
    signal.throwIfAborted();
    try {
      const object = await this.#bucket.get(objectKey(target));
      if (object === null) {
        throw new ContentStorageError(
          "content_not_found",
          "The R2 content does not exist",
        );
      }
      const values = metadata(object);
      const bytes = new Uint8Array(await object.arrayBuffer());
      signal.throwIfAborted();
      if ((await digest(bytes)) !== values.sha256) {
        throw new ContentStorageError(
          "content_storage_unavailable",
          "The R2 content failed integrity validation",
        );
      }
      return { bytes, ...values };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw unavailable("The R2 content could not be read", error);
    }
  };

  readonly write = async (
    target: ContentTarget,
    content: ImmutableContent,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    try {
      if ((await digest(content.bytes)) !== content.sha256) {
        throw new ContentStorageError(
          "content_conflict",
          "The supplied content digest is invalid",
        );
      }
      const key = objectKey(target);
      const written = await this.#bucket.put(
        key,
        Uint8Array.from(content.bytes).buffer,
        {
          customMetadata: {
            contentEncoding: content.contentEncoding,
            mediaType: content.mediaType,
            sha256: content.sha256,
          },
          onlyIf: { etagDoesNotMatch: "*" },
        },
      );
      signal.throwIfAborted();
      if (written !== null) {
        return;
      }
      const existing = await this.#bucket.head(key);
      if (existing === null) {
        throw new ContentStorageError(
          "content_storage_unavailable",
          "The immutable R2 write was not committed",
        );
      }
      const values = metadata(existing);
      if (
        existing.size !== content.bytes.byteLength ||
        values.sha256 !== content.sha256 ||
        values.mediaType !== content.mediaType ||
        values.contentEncoding !== content.contentEncoding
      ) {
        throw new ContentStorageError(
          "content_conflict",
          "Immutable R2 content already exists with different bytes",
        );
      }
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw unavailable("The R2 content could not be written", error);
    }
  };
}
