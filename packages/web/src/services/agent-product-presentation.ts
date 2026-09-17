export type AgentProduct = "claude" | "codex" | "generic";

export function identifyAgentProduct(agentId: string, agentLabel: string): AgentProduct {
    const identity = `${agentId} ${agentLabel}`.toLowerCase();

    if (identity.includes("claude")) {
        return "claude";
    }
    if (identity.includes("codex") || identity.includes("openai")) {
        return "codex";
    }
    return "generic";
}
