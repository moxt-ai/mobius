import type * as p from "@moxt-ai/mobius-protocol";

export type Output =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "file"; readonly name: string }
    | {
          readonly kind: "activity";
          readonly title: string;
          readonly output: string;
          readonly activityType: "reasoning" | "tool";
      };
export interface ReplyPlan {
    readonly output: readonly Output[];
    readonly outcome: "hold" | "complete";
}
export interface FakeDaemonOptions {
    readonly agentId?: string;
    readonly agentName?: string;
    readonly additionalAgents?: readonly { readonly id: string; readonly name: string }[];
    readonly nativeSessionIds?: ReadonlySet<string>;
    readonly reply: (prompt: string, turnNumber: number, mode: "prompt" | "steer") => ReplyPlan;
}
export interface Turn {
    readonly commandIds: readonly [string, ...string[]];
    readonly messages: readonly p.ActiveTurnMessage[];
    readonly epoch: string;
    readonly sequence: number;
}
type Execution =
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly turn: Turn; readonly queued: readonly p.SessionPromptCommand[] };
export interface Session {
    readonly metadata: p.SessionMetadata;
    readonly history: readonly Turn[];
    readonly execution: Execution;
}
