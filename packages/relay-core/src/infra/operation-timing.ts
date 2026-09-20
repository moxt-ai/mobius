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
 * Carries the time an internal Durable Object spent on an operation back to the Worker that called it, so the
 * Worker can separate its own round trip cost from the storage work it waited on.
 */
export const STORAGE_TIMING_HEADER = "x-mobius-storage-duration";

export const encodeStorageDuration = (durationMilliseconds: number): string =>
    Math.max(0, durationMilliseconds).toFixed(1);

export function decodeStorageDuration(value: string | null): number | undefined {
    if (value === null) {
        return undefined;
    }
    const duration = Number.parseFloat(value);
    return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
