import type { PromptResponse } from "@agentclientprotocol/sdk";

// Stateful adapter fixtures avoid paid, nondeterministic provider calls.
// Shapes follow codex-acp 1.8.0 TokenCount.ts and claude-agent-acp 0.73.0 turnOutcome.
export function promptUsageResponse(
  prompt: string,
  turn: number,
): PromptResponse | undefined {
  if (!prompt.startsWith("report ")) {
    return undefined;
  }
  if (prompt === "report absent usage") {
    return { _meta: null, stopReason: "end_turn", usage: null };
  }
  if (prompt === "report unknown metadata") {
    return {
      _meta: { privateData: "must not leave the ACP boundary" },
      stopReason: "end_turn",
    };
  }
  if (prompt === "report empty quota") {
    return {
      _meta: { quota: { token_count: null, model_usage: [] } },
      stopReason: "end_turn",
    };
  }
  const claude = prompt === "report Claude usage";
  const tokenCount = {
    cachedInputTokens: 200 * turn,
    ...(claude ? { cachedWriteTokens: 100 * turn } : {}),
    inputTokens: 600 * turn,
    outputTokens: 200 * turn,
    reasoningOutputTokens: claude ? 0 : 50 * turn,
    totalTokens: (claude ? 1_100 : 1_000) * turn,
  };
  const quota = {
    model_usage: [
      {
        model: claude ? "claude-sonnet" : "gpt-5",
        token_count: tokenCount,
      },
    ],
    token_count: tokenCount,
  };
  return {
    _meta:
      prompt === "report usage only"
        ? null
        : {
            privateData: "must not leave the ACP boundary",
            quota:
              prompt === "report invalid quota"
                ? { ...quota, token_count: { ...tokenCount, totalTokens: -1 } }
                : quota,
          },
    stopReason: prompt === "report cancelled usage" ? "cancelled" : "end_turn",
    usage:
      prompt === "report quota only"
        ? null
        : {
            cachedReadTokens: tokenCount.cachedInputTokens,
            ...(claude ? { cachedWriteTokens: 100 * turn } : {}),
            inputTokens: tokenCount.inputTokens,
            outputTokens: tokenCount.outputTokens,
            thoughtTokens: claude ? null : tokenCount.reasoningOutputTokens,
            totalTokens:
              prompt === "report invalid usage" ? -1 : tokenCount.totalTokens,
          },
  };
}
