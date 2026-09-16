import type { Env, MiddlewareHandler } from "hono";
import { logger } from "../../infra/logger.ts";
import {
    createOperationTimingCollector,
    encodeOperationTiming,
    type OperationTiming,
    type OperationTimingMetric,
} from "../../infra/operation-timing.ts";

interface OperationTimingEnvironment extends Env {
    readonly Variables: { readonly operationTiming: OperationTiming };
}

export function operationTimingMiddleware<
    TEnvironment extends OperationTimingEnvironment,
>(): MiddlewareHandler<TEnvironment> {
    return async (context, next) => {
        const startedAt = performance.now();
        const collector = createOperationTimingCollector();
        context.set("operationTiming", collector.timing);
        await next();
        const completed: readonly OperationTimingMetric[] = [
            {
                description: "Total Platform operation time",
                durationMilliseconds: Math.max(0, performance.now() - startedAt),
                name: "total",
            },
            ...collector.snapshot(),
        ];
        context.header("Server-Timing", encodeOperationTiming(completed));
        logger.info(
            {
                event: "operation-request-timing",
                method: context.req.method,
                path: context.req.path,
                status: context.res.status,
                timings: Object.fromEntries(completed.map((metric) => [metric.name, metric.durationMilliseconds])),
            },
            "Mobius operation timing",
        );
    };
}
