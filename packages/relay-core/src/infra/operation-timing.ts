export interface OperationTiming {
    readonly measure: <T>(name: string, description: string, operation: () => Promise<T>) => Promise<T>;
    readonly record: (name: string, description: string, durationMilliseconds: number) => void;
}

export interface OperationTimingMetric {
    readonly description: string;
    readonly durationMilliseconds: number;
    readonly name: string;
}

export interface OperationTimingCollector {
    readonly snapshot: () => readonly OperationTimingMetric[];
    readonly timing: OperationTiming;
}

export function createOperationTimingCollector(): OperationTimingCollector {
    const metrics: OperationTimingMetric[] = [];
    return {
        snapshot: () => metrics.map((metric) => Object.freeze({ ...metric })),
        timing: {
            measure: async (name, description, operation) => {
                const startedAt = performance.now();
                try {
                    return await operation();
                } finally {
                    metrics.push({
                        description,
                        durationMilliseconds: Math.max(0, performance.now() - startedAt),
                        name,
                    });
                }
            },
            record: (name, description, durationMilliseconds) => {
                if (Number.isFinite(durationMilliseconds) && durationMilliseconds >= 0) {
                    metrics.push({ description, durationMilliseconds, name });
                }
            },
        },
    };
}

export const encodeOperationTiming = (metrics: readonly OperationTimingMetric[]): string =>
    metrics
        .map((metric) => `${metric.name};dur=${metric.durationMilliseconds.toFixed(1)};desc="${metric.description}"`)
        .join(",");

export const unmeasuredOperationTiming: OperationTiming = {
    measure: async (_name, _description, operation) => await operation(),
    record: () => undefined,
};

/**
 * Carries the segments an internal Durable Object measured on its own side back to the Worker that called it.
 * The Durable Object cannot append to the caller's `Server-Timing` header, so it reports its segments through
 * this header and the Worker re-emits them alongside its own.
 */
export const DO_TIMING_HEADER = "x-mobius-do-timing";

/**
 * Prefixes the Durable Object's segments so they never collide with the Worker's own names.
 */
export const DO_TIMING_NAME_PREFIX = "do-";

export const encodeDoTiming = (metrics: readonly OperationTimingMetric[]): string => encodeOperationTiming(metrics);

/**
 * Parses a `Server-Timing` field value into its segments. Values that do not match the emitted shape are
 * ignored rather than rejected, because this header crosses a process boundary.
 */
export function decodeOperationTiming(value: string | null): readonly OperationTimingMetric[] {
    if (value === null) {
        return [];
    }
    const metrics: OperationTimingMetric[] = [];
    for (const entry of value.split(",")) {
        const match = /^\s*([a-z0-9-]+);dur=([0-9.]+)(?:;desc="([^"]*)")?\s*$/u.exec(entry);
        if (match === null) {
            continue;
        }
        const duration = Number.parseFloat(match[2] as string);
        if (!Number.isFinite(duration) || duration < 0) {
            continue;
        }
        metrics.push({
            description: match[3] ?? "",
            durationMilliseconds: duration,
            name: match[1] as string,
        });
    }
    return metrics;
}
