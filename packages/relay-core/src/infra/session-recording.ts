import type { SessionEventEnvelopeV2, SessionRecordingWriteV3 } from "@moxt-ai/mobius-protocol";

export interface SessionRecordingTarget {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
}

export type SessionRecordingDeliveryResult =
    | { readonly kind: "recorded" }
    | { readonly kind: "skipped" }
    | { readonly kind: "failed"; readonly code: "policy_unavailable" | "provider_unavailable" | "write_failed" };

export interface SessionRecording {
    readonly deliver: (
        target: SessionRecordingTarget,
        envelope: SessionEventEnvelopeV2,
        signal: AbortSignal,
    ) => Promise<SessionRecordingDeliveryResult>;
    readonly deliverV3: (
        target: SessionRecordingTarget,
        write: SessionRecordingWriteV3,
        signal: AbortSignal,
    ) => Promise<SessionRecordingDeliveryResult>;
}

export class DisabledSessionRecording implements SessionRecording {
    readonly deliver: SessionRecording["deliver"] = async (_target, _envelope, signal) => {
        signal.throwIfAborted();
        return { kind: "skipped" };
    };
    readonly deliverV3: SessionRecording["deliverV3"] = async (_target, _write, signal) => {
        signal.throwIfAborted();
        return { kind: "skipped" };
    };
}
