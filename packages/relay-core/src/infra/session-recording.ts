import type { ReliableSessionEventEnvelope, SessionEventRejectionCode } from "@moxt-ai/mobius-protocol";

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
    ) => Promise<SessionRecordingDeliveryResult>;
}

export class DisabledSessionRecording implements SessionRecording {
    readonly deliver: SessionRecording["deliver"] = async (_target, _envelope, signal) => {
        signal.throwIfAborted();
        return { kind: "relayed" };
    };
}
