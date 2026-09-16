export interface DurationMetric {
    readonly durationMilliseconds: number;
    readonly name: string;
}

export interface OperationMetrics {
    readonly measure: <T>(name: string, operation: () => Promise<T>) => Promise<T>;
    readonly measureSync: <T>(name: string, operation: () => T) => T;
    readonly snapshot: () => readonly DurationMetric[];
}

export class AccumulatingOperationMetrics implements OperationMetrics {
    readonly #durations = new Map<string, number>();

    readonly measure = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
        const startedAt = performance.now();
        try {
            return await operation();
        } finally {
            this.record(name, performance.now() - startedAt);
        }
    };

    readonly measureSync = <T>(name: string, operation: () => T): T => {
        const startedAt = performance.now();
        try {
            return operation();
        } finally {
            this.record(name, performance.now() - startedAt);
        }
    };

    readonly snapshot = (): readonly DurationMetric[] =>
        Object.freeze(
            [...this.#durations].map(([name, durationMilliseconds]) => Object.freeze({ durationMilliseconds, name })),
        );

    private readonly record = (name: string, durationMilliseconds: number): void => {
        this.#durations.set(name, (this.#durations.get(name) ?? 0) + Math.max(0, durationMilliseconds));
    };
}

export const unmeasuredOperationMetrics: OperationMetrics = Object.freeze({
    measure: async <T>(_name: string, operation: () => Promise<T>): Promise<T> => await operation(),
    measureSync: <T>(_name: string, operation: () => T): T => operation(),
    snapshot: (): readonly DurationMetric[] => Object.freeze([]),
});
