import type { Env, MiddlewareHandler } from "hono";
import { logger } from "../../infra/logger.ts";
import type { OperationTiming } from "../../infra/operation-timing.ts";

interface OperationTimingEnvironment extends Env {
    readonly Variables: { readonly operationTiming: OperationTiming };
}

interface TimingMetric {
    readonly description: string;
    readonly durationMilliseconds: number;
    readonly name: string;
}

export function operationTimingMiddleware<
    TEnvironment extends OperationTimingEnvironment,
>(): MiddlewareHandler<TEnvironment> {
    return async (context, next) => {
        const startedAt = performance.now();
        const metrics: TimingMetric[] = [];
        const operationTiming: OperationTiming = {
            measure: async (name, description, operation) => {
                const operationStartedAt = performance.now();
                try {
                    return await operation();
                } finally {
                    metrics.push({
                        description,
                        durationMilliseconds: Math.max(0, performance.now() - operationStartedAt),
                        name,
                    });
                }
            },
            record: (name, description, durationMilliseconds) => {
                if (Number.isFinite(durationMilliseconds) && durationMilliseconds >= 0) {
                    metrics.push({ description, durationMilliseconds, name });
                }
            },
        };
        context.set("operationTiming", operationTiming);
        await next();
        const completed: readonly TimingMetric[] = [
            {
                description: "Total Platform operation time",
                durationMilliseconds: Math.max(0, performance.now() - startedAt),
                name: "total",
            },
            ...metrics,
        ];
        context.header(
            "Server-Timing",
            completed
                .map(
                    (metric) =>
                        `${metric.name};dur=${metric.durationMilliseconds.toFixed(1)};desc="${metric.description}"`,
                )
                .join(","),
        );
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
