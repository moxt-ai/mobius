import type { Env, MiddlewareHandler } from "hono";

interface RequestSignalEnvironment extends Env {
    readonly Variables: { readonly signal: AbortSignal };
}

export function requestTimeoutMiddleware<TEnvironment extends RequestSignalEnvironment>(
    timeoutMilliseconds: number,
    timeoutError?: (cause: unknown) => Error,
): MiddlewareHandler<TEnvironment> {
    return async (context, next) => {
        const requestSignal = context.req.raw.signal;
        const timeout = new AbortController();
        const timer = setTimeout(
            () => timeout.abort(new DOMException("Request timed out", "TimeoutError")),
            timeoutMilliseconds,
        );
        const signal = AbortSignal.any([requestSignal, timeout.signal]);
        context.set("signal", signal);
        try {
            await next();
        } catch (error) {
            if (requestSignal.aborted || !signal.aborted || timeoutError === undefined) {
                throw error;
            }
            throw timeoutError(error);
        } finally {
            clearTimeout(timer);
        }
    };
}
