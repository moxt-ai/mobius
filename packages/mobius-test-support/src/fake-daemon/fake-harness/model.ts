import type { ToolCallContent } from "@agentclientprotocol/sdk";

export type HarnessOutput =
    | { readonly kind: "message"; readonly text: string }
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "file"; readonly name: string }
    | { readonly kind: "session-title"; readonly title: string }
    | {
          readonly kind: "compaction";
          readonly summary: string;
      }
    | {
          /** Opens a compaction (in_progress) that a later compaction-finish
           *  output settles; other outputs may interleave between them. */
          readonly kind: "compaction-start";
      }
    | {
          /** Settles the compaction opened by compaction-start, streaming the
           *  summary as one chunk before the terminal update. */
          readonly kind: "compaction-finish";
          readonly summary: string;
      }
    | {
          /** Streams no chunks; the terminal completed update carries the summary
           *  as an array of content blocks, exercising the replacement patch. */
          readonly kind: "compaction-summary-blocks";
          readonly blocks: readonly string[];
      }
    | {
          readonly kind: "usage";
          readonly used: number;
          readonly size: number;
          readonly cost: { readonly amount: number; readonly currency: string };
      }
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
