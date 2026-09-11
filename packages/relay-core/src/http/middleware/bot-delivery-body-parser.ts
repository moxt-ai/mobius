import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { BotDeliveryError } from "../../entity/bot/bot-delivery-error.ts";
import { RequestBodyError, readBoundedUtf8Body } from "../../infra/bounded-request-body.ts";

async function parseBotDeliveryBody<TSchema extends v.GenericSchema<unknown, object>>(
    request: Request,
    schema: TSchema,
): Promise<v.InferOutput<TSchema>> {
    let encoded: string;
    try {
        encoded = await readBoundedUtf8Body(request, 64 * 1024);
    } catch (cause) {
        if (cause instanceof RequestBodyError) {
            throw new BotDeliveryError("invalid_request", "The connection operation is invalid", { cause });
        }
        throw cause;
    }
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotDeliveryError("invalid_request", "The connection operation is invalid", { cause });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new BotDeliveryError("invalid_request", "The connection operation must be an object");
    }
    const result = v.safeParse(schema, value);
    if (!result.success) {
        throw new BotDeliveryError("invalid_request", "The connection operation is invalid", {
            cause: new v.ValiError(result.issues),
        });
    }
    return result.output;
}

export function botDeliveryBodyParser<TSchema extends v.GenericSchema<unknown, object>>(schema: TSchema) {
    return createMiddleware<
        { readonly Variables: Record<string, never> },
        string,
        {
            in: { json: v.InferInput<TSchema> };
            out: { json: v.InferOutput<TSchema> };
        }
    >(async (context, next) => {
        context.req.addValidatedData("json", await parseBotDeliveryBody(context.req.raw, schema));
        await next();
    });
}
