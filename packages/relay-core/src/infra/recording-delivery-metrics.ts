import type { OperationTimingMetric } from "./operation-timing.ts";
import type { SessionRecordingDeliveryResult } from "./session-recording.ts";

/**
 * Bounded duration window. Percentiles stay approximate once the window wraps, which is acceptable for
 * capacity observation and keeps a long-lived Runtime Relay Durable Object from growing without limit.
 */
const DURATION_SAMPLE_CAPACITY = 1_024;
const SEGMENT_NAME_CAPACITY = 16;
const SEGMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export type RecordingDeliveryOutcome = SessionRecordingDeliveryResult["kind"];

export interface RecordingDurationSummary {
    readonly count: number;
    readonly max: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
}

export interface RuntimeMessageSchedulerDepth {
    readonly active: number;
    readonly lanes: number;
    readonly pending: number;
}

/** Recording delivery cost as measured inside the channel that forwards Session events. */
export interface RecordingDeliveryDurationSnapshot {
    readonly deliveries: number;
    readonly durationMilliseconds: RecordingDurationSummary;
    readonly outcomes: Readonly<Record<RecordingDeliveryOutcome, number>>;
    readonly recording: Readonly<Record<string, RecordingDurationSummary>>;
}

/** The reported snapshot plus the Runtime's message queue depth, which is the Relay-side backlog. */
export interface RecordingDeliveryMetricsSnapshot extends RecordingDeliveryDurationSnapshot {
    readonly scheduler: RuntimeMessageSchedulerDepth;
}

class DurationWindow {
    readonly #samples = new Float64Array(DURATION_SAMPLE_CAPACITY);
    #count = 0;

    readonly add = (durationMilliseconds: number): void => {
        if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0) {
            return;
        }
        this.#samples[this.#count % DURATION_SAMPLE_CAPACITY] = durationMilliseconds;
        this.#count += 1;
    };

    readonly summarize = (): RecordingDurationSummary => {
        const observed = Math.min(this.#count, DURATION_SAMPLE_CAPACITY);
        // Once the window wraps, keep the most recent samples in ascending index order.
        const first = this.#count - observed;
        const sorted = Float64Array.from(
            { length: observed },
            (_value, index) => this.#samples[(first + index) % DURATION_SAMPLE_CAPACITY] ?? 0,
        ).sort();
        return {
            count: observed,
            max: observed === 0 ? 0 : round(sorted[observed - 1] ?? 0),
            p50: round(percentile(sorted, 0.5)),
            p95: round(percentile(sorted, 0.95)),
            p99: round(percentile(sorted, 0.99)),
        };
    };
}

/**
 * Aggregates how long Recording delivery takes, how it resolves, and how deep the Runtime message queue is,
 * so an operator can tell whether the Relay keeps up with the Session event stream instead of inferring it
 * from reliability behavior alone. Values live in Durable Object memory and reset when the object is evicted.
 */
export class RecordingDeliveryMetrics {
    readonly #delivery = new DurationWindow();
    readonly #outcomes: Record<RecordingDeliveryOutcome, number> = {
        deferred: 0,
        recorded: 0,
        rejected: 0,
        relayed: 0,
    };
    readonly #segments = new Map<string, DurationWindow>();
    #total = 0;

    readonly record = (
        outcome: RecordingDeliveryOutcome,
        durationMilliseconds: number,
        timings: readonly OperationTimingMetric[] = [],
    ): void => {
        this.#outcomes[outcome] += 1;
        this.#total += 1;
        this.#delivery.add(durationMilliseconds);
        for (const timing of timings) {
            const name = timing.name;
            if (!SEGMENT_NAME_PATTERN.test(name)) {
                continue;
            }
            let window = this.#segments.get(name);
            if (window === undefined) {
                if (this.#segments.size >= SEGMENT_NAME_CAPACITY) {
                    continue;
                }
                window = new DurationWindow();
                this.#segments.set(name, window);
            }
            window.add(timing.durationMilliseconds);
        }
    };

    readonly snapshot = (): RecordingDeliveryDurationSnapshot => {
        const recording: Record<string, RecordingDurationSummary> = {};
        for (const [name, window] of [...this.#segments.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
        )) {
            recording[name] = window.summarize();
        }
        return {
            deliveries: this.#total,
            durationMilliseconds: this.#delivery.summarize(),
            outcomes: { ...this.#outcomes },
            recording,
        };
    };
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function percentile(sorted: Float64Array, fraction: number): number {
    if (sorted.length === 0) {
        return 0;
    }
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
    return sorted[rank] ?? 0;
}

/**
 * Decodes the snapshot that crosses the Runtime Relay Durable Object boundary. The Durable Object is a separate
 * execution context, so its response is untrusted input and must be validated before it reaches a caller.
 */
export function decodeRecordingDeliveryMetrics(value: unknown): RecordingDeliveryMetricsSnapshot {
    if (!isRecord(value)) {
        throw new RecordingDeliveryMetricsError();
    }
    const deliveries = number(value["deliveries"]);
    const outcomes = value["outcomes"];
    if (!isRecord(outcomes)) {
        throw new RecordingDeliveryMetricsError();
    }
    const scheduler = value["scheduler"];
    if (!isRecord(scheduler)) {
        throw new RecordingDeliveryMetricsError();
    }
    const recording = value["recording"];
    const segments: Record<string, RecordingDurationSummary> = {};
    if (recording !== undefined) {
        if (!isRecord(recording)) {
            throw new RecordingDeliveryMetricsError();
        }
        for (const [name, summary] of Object.entries(recording)) {
            segments[name] = duration(summary);
        }
    }
    return {
        deliveries,
        durationMilliseconds: duration(value["durationMilliseconds"]),
        outcomes: {
            deferred: number(outcomes["deferred"]),
            recorded: number(outcomes["recorded"]),
            rejected: number(outcomes["rejected"]),
            relayed: number(outcomes["relayed"]),
        },
        recording: segments,
        scheduler: {
            active: number(scheduler["active"]),
            lanes: number(scheduler["lanes"]),
            pending: number(scheduler["pending"]),
        },
    };
}

export class RecordingDeliveryMetricsError extends Error {
    readonly code = "invalid_recording_metrics";

    constructor() {
        super("The Runtime returned invalid Recording delivery metrics");
        this.name = "RecordingDeliveryMetricsError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new RecordingDeliveryMetricsError();
    }
    return value;
}

function duration(value: unknown): RecordingDurationSummary {
    if (!isRecord(value)) {
        throw new RecordingDeliveryMetricsError();
    }
    return {
        count: number(value["count"]),
        max: number(value["max"]),
        p50: number(value["p50"]),
        p95: number(value["p95"]),
        p99: number(value["p99"]),
    };
}
