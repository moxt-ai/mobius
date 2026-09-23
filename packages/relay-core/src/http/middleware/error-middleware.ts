import { createMiddleware } from "hono/factory";
import { toHttpError } from "../../entity/http-error.ts";
import { logger } from "../../infra/logger.ts";

export function rethrowHonoError(error: Error): never {
    throw error;
}

export const errorMiddleware = createMiddleware(async (context, next) => {
    try {
        return await next();
    } catch (error) {
        logger.error({ err: error }, "Mobius request failed");
        if (context.req.raw.signal.aborted) {
            throw error;
        }
        const response = toHttpError(error);
        const result = Response.json(response.body, {
            status: response.status,
            headers: response.headers ?? {},
        });
        return context.newResponse(result.body, result);
    }
});
