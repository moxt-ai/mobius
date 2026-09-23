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
          readonly kind: "narration";
          readonly activityId: string;
          readonly attemptId: string;
          readonly commandId: string;
          readonly text: string;
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

/**
 * Whether a committed event is Session activity the user caused, which is what the directory's
 * `updated_at` records. The directory orders the conversation list and its timestamp is the only
 * activity signal a browser has before it loads a Session, so an event that does not represent user
 * activity must not move it.
 *
 * A readiness report is the case this exists for: a browser opening an existing Session prepares it,
 * the daemon answers with `session.ready`, and stamping that as activity lifted the Session the user
 * merely opened to the head of the list they were reading. `unchanged` covers the same class — a
 * readiness report, a repeated command list, or an Agent update that carries no title.
 *
 * The remaining variants are exhaustive on purpose, so a new projection has to state which side it
 * belongs on rather than inheriting the activity stamp by default.
 */
export function isSessionActivity(projection: SessionEventProjection): boolean {
    switch (projection.kind) {
        case "unchanged":
            return false;
        case "start":
        case "response":
        case "content":
        case "activity":
        case "narration":
        case "request-interaction":
        case "resolve-interaction":
        case "complete":
        case "fail":
        case "configuration":
        case "title":
            return true;
        default: {
            const unreachable: never = projection;
            return unreachable;
        }
    }
}
