import type { ToolCallContent } from "@agentclientprotocol/sdk";

export type HarnessOutput =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "file"; readonly name: string }
    | { readonly kind: "session-title"; readonly title: string }
    | {
          readonly kind: "activity";
          readonly title: string;
          readonly output: string;
          readonly activityType: "reasoning";
      }
    | {
          readonly kind: "activity";
          readonly title: string;
          readonly output: string;
          readonly activityType: "tool";
          readonly content: readonly ToolCallContent[];
      };

export interface HarnessReplyPlan {
    readonly output: readonly HarnessOutput[];
    readonly outcome: "hold" | "complete";
}

export interface FakeAgentHarnessOptions {
    readonly agentId?: string;
    readonly agentName?: string;
    readonly additionalAgents?: readonly { readonly id: string; readonly name: string }[];
    readonly echoUserMessage?: boolean;
    readonly nativeSessionIds?: ReadonlySet<string>;
    readonly reply: (prompt: string, turnNumber: number, mode: "prompt" | "steer") => HarnessReplyPlan;
}
