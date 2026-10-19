import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { SessionCapabilities } from "@moxt-ai/mobius-sdk/protocol";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTrueChildField(value: unknown, childKey: string, fieldKey: string): boolean {
    if (!isRecord(value)) {
        return false;
    }
    const child = Reflect.get(value, childKey);
    return isRecord(child) && Reflect.get(child, fieldKey) === true;
}

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
        promptQueueing: false,
        renameSession: false,
        resumeSession: false,
        steering: false,
        unstableForkSession: false,
    });
}

export function normalizeAcpCapabilities(initialized: InitializeResponse): SessionCapabilities {
    const capabilities = initialized.agentCapabilities ?? {};
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
        promptQueueing: hasTrueChildField(capabilities._meta, "claudeCode", "promptQueueing"),
        renameSession: hasTrueChildField(initialized._meta, "renameSession", "supported"),
        resumeSession: session?.resume != null,
        steering: hasTrueChildField(initialized._meta, "steering", "supported"),
        unstableForkSession: session?.fork != null,
    });
}
