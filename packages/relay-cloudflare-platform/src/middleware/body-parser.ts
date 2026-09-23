import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";

const DEFAULT_MAXIMUM_BODY_BYTES = 128 * 1_024;

interface BodyParserEnvironment {
    readonly Variables: { readonly signal: AbortSignal };
}

export function bodyParser<TSchema extends v.GenericSchema<unknown, object>>(
    schema: TSchema,
    maximumBodyBytes = DEFAULT_MAXIMUM_BODY_BYTES,
) {
    return createMiddleware<
        BodyParserEnvironment,
        string,
        {
            in: { json: v.InferInput<TSchema> };
            out: { json: v.InferOutput<TSchema> };
        }
    >(async (context, next) => {
        const value = await parseBody(context.req.raw, schema, context.var.signal, maximumBodyBytes);
        context.req.addValidatedData("json", value);
        await next();
    });
}

async function parseBody<TSchema extends v.GenericSchema<unknown, object>>(
    request: Request,
    schema: TSchema,
    signal: AbortSignal,
    maximumBodyBytes: number,
): Promise<v.InferOutput<TSchema>> {
    signal.throwIfAborted();
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "application/json") {
        throw new PlatformControlPlaneError("invalid_request", "A JSON request body is required", 400);
    }
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > maximumBodyBytes) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is too large", 413);
    }
    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    let encoded = "";
    let length = 0;
    if (reader !== undefined) {
        const cancel = () => {
            void reader.cancel(signal.reason).catch(() => undefined);
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
            for (;;) {
                signal.throwIfAborted();
                const chunk = await reader.read();
                signal.throwIfAborted();
                if (chunk.done) {
                    encoded += decoder.decode();
                    break;
                }
                length += chunk.value.byteLength;
                if (length > maximumBodyBytes) {
                    void reader.cancel().catch(() => undefined);
                    throw new PlatformControlPlaneError("invalid_request", "The request body is too large", 413);
                }
                encoded += decoder.decode(chunk.value, { stream: true });
            }
        } finally {
            signal.removeEventListener("abort", cancel);
            reader.releaseLock();
        }
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is invalid", 400, { cause });
    }
    const result = v.safeParse(
        v.pipe(
            v.unknown(),
            v.check((input) => typeof input === "object" && input !== null && !Array.isArray(input)),
            schema,
        ),
        value,
    );
    if (!result.success) {
        throw new PlatformControlPlaneError("invalid_request", "The request body is invalid", 400, {
            cause: new v.ValiError(result.issues),
        });
    }
    return result.output;
}
