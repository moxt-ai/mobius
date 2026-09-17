import type { AgentActivityEvent, AgentContentEvent, Interaction, SessionConfigOption } from "@moxt-ai/mobius-protocol";

export interface SessionEventCommit {
    readonly scopeKey: string;
    readonly sessionId: string;
    readonly sequenceNumber: number;
    readonly eventId: string;
    readonly payloadHash: string;
    readonly sourceKind: string;
    readonly sourceId: string;
    readonly sourceSeq: string;
    readonly expectedPreviousSourceSequence: string | null;
    readonly messageId: string;
    readonly payload: string;
    readonly recordedAt: number;
    readonly projection: SessionEventProjection;
    readonly activityDetail: {
        readonly artifactId: string;
        readonly activityId: string;
        readonly payload: string;
    } | null;
}

export type SessionEventProjection =
    | { readonly kind: "unchanged" }
    | {
          readonly kind: "start";
          readonly commandId: string;
          readonly turnId: string;
          readonly bindingId: string;
          readonly attemptId: string;
      }
    | { readonly kind: "response"; readonly commandId: string; readonly text: string }
    | { readonly kind: "content"; readonly event: AgentContentEvent }
    | {
          readonly kind: "activity";
          readonly attemptId: string;
          readonly event: AgentActivityEvent;
          readonly hotDetail: string | null;
      }
    | {
          readonly kind: "request-interaction";
          readonly interactionId: string;
          readonly turnId: string;
          readonly attemptId: string;
          readonly request: Interaction["request"];
          readonly disposition:
              | { readonly kind: "cancel" }
              | { readonly kind: "wait"; readonly interactionIds: readonly string[] };
      }
    | {
          readonly kind: "resolve-interaction";
          readonly interactionId: string;
          readonly attemptId: string;
          readonly attemptState: "running" | "waiting_input";
          readonly interactionIds: readonly string[];
      }
    | {
          readonly kind: "complete";
          readonly commandId: string;
          readonly turnId: string;
          readonly state: "cancelled" | "succeeded";
          readonly stopReason: string;
      }
    | {
          readonly kind: "fail";
          readonly commandId: string;
          readonly turnId: string;
          readonly attemptSourceId: string | null;
          readonly dispatchAttempt: { readonly attemptId: string; readonly bindingId: string } | null;
          readonly code: string;
          readonly message: string;
      }
    | {
          readonly kind: "configuration";
          readonly bindingId: string;
          readonly configRevision: number;
          readonly configOptions: readonly SessionConfigOption[];
          readonly binding: {
              readonly runtimeId: string;
              readonly agentRef: string;
              readonly workspaceRef: string;
          } | null;
      }
    | { readonly kind: "title"; readonly title: string };
