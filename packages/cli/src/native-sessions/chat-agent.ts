import { nativeSessionIdSchema } from "../acp/native-session.ts";

/** Agents with native Sessions that can back a Bot conversation. */
export function supportsNativeChat(agentId: string): boolean {
    return agentId === "codex" || agentId === "claude" || agentId === "opencode" || agentId === "pi";
}

export function isNativeChatSessionId(agentId: string, sessionId: string): boolean {
    if (!nativeSessionIdSchema.safeParse(sessionId).success) {
        return false;
    }
    if (agentId === "opencode") {
        return /^ses_[a-zA-Z0-9]+$/.test(sessionId);
    }
    return (
        (agentId === "codex" || agentId === "claude" || agentId === "pi") &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sessionId)
    );
}
