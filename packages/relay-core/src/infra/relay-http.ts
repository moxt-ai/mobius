import { PairingDirectoryError } from "../entity/pairing/pairing.ts";
import { RequestBodyError, readBoundedUtf8Body } from "./bounded-request-body.ts";

const MAX_REQUEST_BODY_LENGTH = 16 * 1024;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
        throw new PairingDirectoryError("invalid_request", "The request fields are invalid");
    }
}

export async function parseJsonBody(
    request: Request,
    maximumLength = MAX_REQUEST_BODY_LENGTH,
): Promise<Readonly<Record<string, unknown>>> {
    let encoded: string;
    try {
        encoded = await readBoundedUtf8Body(request, maximumLength);
    } catch (cause) {
        if (cause instanceof RequestBodyError) {
            throw new PairingDirectoryError(
                "invalid_request",
                cause.code === "body_too_large" ? "The request body is too large" : "The request body is invalid",
                { cause },
            );
        }
        throw cause;
    }
    if (encoded.length === 0) {
        throw new PairingDirectoryError("invalid_request", "The request body is invalid");
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new PairingDirectoryError("invalid_request", "The request body is not valid JSON", { cause });
    }
    if (!isRecord(value)) {
        throw new PairingDirectoryError("invalid_request", "The request body must be a JSON object");
    }
    return value;
}

export function readString(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength = 128,
    allowEmpty = false,
): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximumLength || (!allowEmpty && field.length === 0)) {
        throw new PairingDirectoryError("invalid_request", `The ${key} field is invalid`);
    }
    return field;
}

export function bearerToken(request: Request): string {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
        throw new PairingDirectoryError("unauthorized", "A project bearer token is required");
    }
    return authorization.slice("Bearer ".length);
}
