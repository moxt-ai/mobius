export type RequestBodyErrorCode =
  | "body_empty"
  | "body_invalid_encoding"
  | "body_invalid_length"
  | "body_read_failed"
  | "body_too_large";

export class RequestBodyError extends Error {
  readonly code: RequestBodyErrorCode;

  constructor(
    code: RequestBodyErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.code = code;
    this.name = "RequestBodyError";
  }
}

function declaredBodyLength(
  request: Request,
  maximumBytes: number,
): number | null {
  const header = request.headers.get("content-length");
  if (header === null) {
    return null;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(header)) {
    throw new RequestBodyError(
      "body_invalid_length",
      "The request Content-Length is invalid",
    );
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length)) {
    throw new RequestBodyError(
      "body_invalid_length",
      "The request Content-Length is invalid",
    );
  }
  if (length > maximumBytes) {
    throw new RequestBodyError(
      "body_too_large",
      "The request body is too large",
    );
  }
  return length;
}

export async function readBoundedUtf8Body(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  request.signal.throwIfAborted();
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RequestBodyError(
      "body_invalid_length",
      "The request body limit is invalid",
    );
  }
  const declaredLength = declaredBodyLength(request, maximumBytes);
  const reader = request.body?.getReader();
  if (reader === undefined) {
    throw new RequestBodyError("body_empty", "The request body is empty");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let byteLength = 0;
  let encoded = "";
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      request.signal.throwIfAborted();
      if (chunk.done) {
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > maximumBytes) {
        try {
          await reader.cancel("Request body limit exceeded");
        } catch (cause) {
          request.signal.throwIfAborted();
          throw new RequestBodyError(
            "body_read_failed",
            "The oversized request body could not be cancelled",
            { cause },
          );
        }
        throw new RequestBodyError(
          "body_too_large",
          "The request body is too large",
        );
      }
      encoded += decoder.decode(chunk.value, { stream: true });
    }
    encoded += decoder.decode();
  } catch (cause) {
    request.signal.throwIfAborted();
    if (cause instanceof RequestBodyError) {
      throw cause;
    }
    throw new RequestBodyError(
      cause instanceof TypeError ? "body_invalid_encoding" : "body_read_failed",
      cause instanceof TypeError
        ? "The request body is not valid UTF-8"
        : "The request body could not be read",
      { cause },
    );
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== null && declaredLength !== byteLength) {
    throw new RequestBodyError(
      "body_invalid_length",
      "The request body length does not match Content-Length",
    );
  }
  if (byteLength === 0) {
    throw new RequestBodyError("body_empty", "The request body is empty");
  }
  return encoded;
}
