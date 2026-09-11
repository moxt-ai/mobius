import type { Env, MiddlewareHandler } from "hono";

export function rethrowHonoError(error: Error): never {
    throw error;
}

export function errorResponseMiddleware<TEnvironment extends Env>(
    errorResponse: (error: unknown) => Response,
): MiddlewareHandler<TEnvironment> {
    return async (context, next) => {
        try {
            return await next();
        } catch (error) {
            if (context.req.raw.signal.aborted) {
                throw error;
            }
            return errorResponse(error);
        }
    };
}
