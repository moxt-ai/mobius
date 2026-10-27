import type { SessionWireEnvelope } from "@moxt-ai/mobius-sdk/protocol";

export interface SessionRecordingTarget {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
}

export type SessionRecordingDeliveryResult =
    | { readonly kind: "recorded" }
    | { readonly kind: "skipped" }
    | { readonly kind: "failed"; readonly code: "policy_unavailable" | "provider_unavailable" | "write_failed" };

export interface SessionRecordingScope {
    readonly projectId: string;
    readonly runtimeId: string;
}

export type SessionRecordingBatchResult = SessionRecordingDeliveryResult & { readonly sessionId: string };

export interface SessionRecording {
    readonly deliverBatch: (
        target: SessionRecordingScope,
        envelope: SessionWireEnvelope,
        signal: AbortSignal,
    ) => Promise<readonly SessionRecordingBatchResult[]>;
}

export class DisabledSessionRecording implements SessionRecording {
    readonly deliverBatch: SessionRecording["deliverBatch"] = async (_target, envelope, signal) => {
        signal.throwIfAborted();
        return [...new Set(envelope.events.map((event) => event.sessionId))].map((sessionId) => ({
            sessionId,
            kind: "skipped",
        }));
    };
}
