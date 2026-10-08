export type HarnessOutput =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "file"; readonly name: string }
    | {
          readonly kind: "activity";
          readonly title: string;
          readonly output: string;
          readonly activityType: "reasoning" | "tool";
      };

export interface HarnessReplyPlan {
    readonly output: readonly HarnessOutput[];
    readonly outcome: "hold" | "complete";
}

export interface FakeAgentHarnessOptions {
    readonly agentId?: string;
    readonly agentName?: string;
    readonly additionalAgents?: readonly { readonly id: string; readonly name: string }[];
    readonly nativeSessionIds?: ReadonlySet<string>;
    readonly reply: (prompt: string, turnNumber: number, mode: "prompt" | "steer") => HarnessReplyPlan;
}
