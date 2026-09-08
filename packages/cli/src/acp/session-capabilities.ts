import type { AgentCapabilities } from "@agentclientprotocol/sdk";
import type { SessionCapabilities } from "@moxt-ai/mobius-protocol";

export function unsupportedSessionCapabilities(): SessionCapabilities {
    return Object.freeze({
        additionalDirectories: false,
        audioPrompt: false,
        closeSession: false,
        deleteSession: false,
        embeddedContextPrompt: false,
        imagePrompt: false,
        listSessions: false,
        loadSession: false,
        resumeSession: false,
        unstableForkSession: false,
    });
}

export function normalizeAcpCapabilities(capabilities: AgentCapabilities): SessionCapabilities {
    const session = capabilities.sessionCapabilities;
    const prompt = capabilities.promptCapabilities;
    return Object.freeze({
        additionalDirectories: session?.additionalDirectories != null,
        audioPrompt: prompt?.audio === true,
        closeSession: session?.close != null,
        deleteSession: session?.delete != null,
        embeddedContextPrompt: prompt?.embeddedContext === true,
        imagePrompt: prompt?.image === true,
        listSessions: session?.list != null,
        loadSession: capabilities.loadSession === true,
        resumeSession: session?.resume != null,
        unstableForkSession: session?.fork != null,
    });
}
