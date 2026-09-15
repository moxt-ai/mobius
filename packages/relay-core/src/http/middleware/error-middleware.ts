import { createMiddleware } from "hono/factory";
import { isHttpError } from "../../entity/http-error.ts";
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
        const response = isHttpError(error)
            ? error.toHttpJson()
            : {
                  body: { error: { code: "internal_error", message: "The request could not be completed" } },
                  status: 500,
                  headers: {},
              };
        const result = Response.json(response.body, {
            status: response.status,
            headers: response.headers ?? {},
        });
        return context.newResponse(result.body, result);
    }
});
