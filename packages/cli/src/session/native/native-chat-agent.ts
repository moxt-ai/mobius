import { nativeSessionIdSchema } from "../../acp/protocol/native-session.ts";

/** Agents with native Sessions that can back a Bot conversation. */
export function supportsNativeChat(agentId: string): boolean {
    return agentId === "codex" || agentId === "claude" || agentId === "pi";
}

export function isNativeChatSessionId(agentId: string, sessionId: string): boolean {
    if (!nativeSessionIdSchema.safeParse(sessionId).success) {
        return false;
    }
    return (
        (agentId === "codex" || agentId === "claude" || agentId === "pi") &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sessionId)
    );
}
