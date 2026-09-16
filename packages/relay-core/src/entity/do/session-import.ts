import type {
    AgentActivityEvent,
    CommittedSessionEvent,
    Interaction,
    NativeSessionHistory,
    SessionBinding,
    SessionPromptCommand,
} from "@moxt-ai/mobius-protocol";

export interface ImportedCommand {
    readonly bindingId: string;
    readonly command: SessionPromptCommand;
    readonly completedAt: number | null;
    readonly createdAt: number;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly idempotencyKey: string;
    readonly attemptId: string | null;
    readonly requestHash: string;
    readonly response: string;
    readonly startedAt: number | null;
    readonly state: "cancelled" | "failed" | "indeterminate" | "queued" | "running" | "succeeded";
    readonly stopReason: string | null;
    readonly turnId: string;
    readonly updatedAt: number;
}

export interface ImportedActivity {
    readonly attemptId: string;
    readonly event: AgentActivityEvent;
    readonly eventSequence: number;
}

export interface ImportedInteraction {
    readonly interactionId: string;
    readonly turnId: string;
    readonly attemptId: string;
    readonly request: Interaction["request"];
    readonly state: Extract<Interaction["state"], { readonly kind: "resolved" | "expired" | "cancelled" }>;
}

export interface SessionImportPlan {
    readonly scopeKey: string;
    readonly sessionId: string;
    readonly nativeHistory: NativeSessionHistory | null;
    readonly bindings: readonly SessionBinding[];
    readonly commands: readonly ImportedCommand[];
    readonly interactions: readonly ImportedInteraction[];
    readonly activities: readonly {
        readonly activity: ImportedActivity;
        readonly artifact: { readonly artifactId: string; readonly payload: string } | null;
    }[];
    readonly events: readonly {
        readonly event: CommittedSessionEvent;
        readonly payloadHash: string;
        readonly sourceId: string;
    }[];
    readonly targetBindingId: string;
    readonly configRevision: number;
    readonly minimumSequence: number;
    readonly nextSequence: number;
    readonly updatedAt: number;
}
