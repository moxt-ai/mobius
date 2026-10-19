import type { SessionEventEnvelope } from "@moxt-ai/mobius-sdk/protocol";

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
        envelope: SessionEventEnvelope,
        signal: AbortSignal,
    ) => Promise<SessionRecordingDeliveryResult>;
}

export class DisabledSessionRecording implements SessionRecording {
    readonly deliver: SessionRecording["deliver"] = async (_target, _envelope, signal) => {
        signal.throwIfAborted();
        return { kind: "skipped" };
    };
}
