import type { ReliableSessionEventEnvelope, SessionEventRejectionCode } from "@moxt-ai/mobius-protocol";
import type { OperationTiming, OperationTimingMetric } from "./operation-timing.ts";

/**
 * Carries the Recording Worker's own measured segments back to the Relay that called it. The Recording Worker
 * declares the same name in `packages/recording-cloudflare`; the Recording integration test fails if they drift.
 */
export const RECORDING_TIMING_HEADER = "x-mobius-recording-timing";

/** Parses the Recording Worker's timing header into collector segments the Relay can aggregate. */
export const decodeRecordingTiming = (response: Response): readonly OperationTimingMetric[] => {
    const value = response.headers.get(RECORDING_TIMING_HEADER);
    if (value === null) {
        return [];
    }
    const metrics: OperationTimingMetric[] = [];
    for (const segment of value.split(",")) {
        const match = /^([a-z0-9-]+);dur=([0-9.]+)$/u.exec(segment.trim());
        if (match === null) {
            continue;
        }
        const durationMilliseconds = Number.parseFloat(match[2] as string);
        if (Number.isFinite(durationMilliseconds) && durationMilliseconds >= 0) {
            metrics.push({
                description: "",
                durationMilliseconds,
                name: match[1] as string,
            });
        }
    }
    return metrics;
};

export interface SessionRecordingTarget {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
}

export type SessionRecordingDeliveryResult =
    | { readonly kind: "relayed" }
    | { readonly kind: "recorded"; readonly providerId: string; readonly recordingEpoch: string }
    | { readonly kind: "deferred"; readonly retryAfterMilliseconds: number }
    | {
          readonly kind: "rejected";
          readonly code: (typeof SessionEventRejectionCode)[keyof typeof SessionEventRejectionCode];
      };

export interface SessionRecording {
    readonly deliver: (
        target: SessionRecordingTarget,
        envelope: ReliableSessionEventEnvelope,
        signal: AbortSignal,
        timing?: OperationTiming,
    ) => Promise<SessionRecordingDeliveryResult>;
}

export class DisabledSessionRecording implements SessionRecording {
    readonly deliver: SessionRecording["deliver"] = async (_target, _envelope, signal) => {
        signal.throwIfAborted();
        return { kind: "relayed" };
    };
}
