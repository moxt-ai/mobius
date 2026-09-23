import type { CommittedSessionEvent } from "@moxt-ai/mobius-protocol";

export type LiveSessionEvent =
    | { readonly kind: "ready" }
    | { readonly event: CommittedSessionEvent; readonly kind: "event" }
    | { readonly kind: "heartbeat" }
    | { readonly kind: "end" };

export interface SessionEventReceiver {
    readonly receive: (message: LiveSessionEvent) => Promise<void>;
}
