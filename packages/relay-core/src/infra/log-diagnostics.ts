const MAX_ERROR_DEPTH = 4;

export function diagnosticText(value: string, maximumLength = 2_048): string {
    return value
        .slice(0, maximumLength)
        .replace(/\bBearer\s+[^\s"'<>]+/giu, "Bearer [redacted]")
        .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/giu, (value) => {
            try {
                const url = new URL(value);
                url.username = "";
                url.password = "";
                url.search = "";
                url.hash = "";
                return url.toString();
            } catch {
                return "[redacted-url]";
            }
        })
        .slice(0, maximumLength);
}

function errorProperty(error: object, key: string): unknown {
    try {
        return Reflect.get(error, key);
    } catch {
        // Diagnostics must not replace the original failure when an Error has a broken getter.
        return undefined;
    }
}

function serializeCause(error: unknown, seen: Set<object>, depth: number): unknown {
    if (depth >= MAX_ERROR_DEPTH) {
        return "[Truncated cause]";
    }
    if (typeof error !== "object" || error === null) {
        return {
            name: "NonError",
            message: diagnosticText(typeof error === "function" ? "[Function thrown]" : String(error)),
        };
    }
    if (seen.has(error)) {
        return "[Circular cause]";
    }
    seen.add(error);
    const result: Record<string, unknown> = {};
    for (const [key, maximumLength] of [
        ["name", 256],
        ["message", 2_048],
        ["stack", 4_096],
    ] as const) {
        const value = errorProperty(error, key);
        if (typeof value === "string") {
            result[key] = diagnosticText(value, maximumLength);
        }
    }
    // Copy diagnostic fields explicitly: arbitrary error properties can contain credentials or payloads.
    for (const key of [
        "code",
        "errno",
        "syscall",
        "status",
        "statusCode",
        "httpStatus",
        "overloaded",
        "retryable",
        "remote",
        "durableObjectReset",
    ]) {
        const value = errorProperty(error, key);
        if (typeof value === "boolean" || typeof value === "number") {
            result[key] = value;
        } else if (typeof value === "string") {
            result[key] = diagnosticText(value, 256);
        }
    }
    const cause = errorProperty(error, "cause");
    if (cause !== undefined) {
        result["cause"] = serializeCause(cause, seen, depth + 1);
    }
    return result;
}

export function serializeDiagnosticError(error: unknown): unknown {
    return serializeCause(error, new Set(), 0);
}

export function requestLogContext(request: Request) {
    return {
        cfRay: request.headers.get("cf-ray")?.slice(0, 128) ?? null,
        method: request.method,
        path: new URL(request.url).pathname,
    };
}
