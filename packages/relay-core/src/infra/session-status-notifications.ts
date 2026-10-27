import type { SessionEventEnvelope } from "@moxt-ai/mobius-sdk/protocol";

export interface SessionStatusNotifications {
    readonly publish: (
        scope: { readonly projectId: string; readonly runtimeId: string },
        envelope: SessionEventEnvelope,
    ) => void;
}
