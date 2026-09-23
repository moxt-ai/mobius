/** Agents with native Sessions that can back a Bot conversation. */
export function supportsNativeChat(agentId: string): boolean {
    return agentId === "codex" || agentId === "claude";
}
