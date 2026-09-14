import type { BotConnectorCredential, BotRuntimeCredential } from "../entity/bot/bot-access.ts";

export interface InboundCredentialPlaneRecord {
    readonly connection_id: unknown;
    readonly plane: string;
}

interface BotProjectScopeRecord {
    readonly project_id: string;
}

export interface BotConversationScopeRecord extends BotProjectScopeRecord {
    readonly bot_id: string;
    readonly session_id: string;
}

export class MissingBotConversationScope {}

export class FoundBotConversationScope {
    readonly botId: string;
    readonly projectId: string;
    readonly sessionId: string;

    constructor(projectId: string, botId: string, sessionId: string) {
        this.projectId = projectId;
        this.botId = botId;
        this.sessionId = sessionId;
    }
}

export interface BotCredentialRecords {
    readonly botExists: (botId: string, signal: AbortSignal) => Promise<boolean>;
    readonly botExistsInProject: (botId: string, projectId: string, signal: AbortSignal) => Promise<boolean>;
    readonly readConversationProjectScope: (
        conversationId: string,
        signal: AbortSignal,
    ) => Promise<FoundBotConversationScope | MissingBotConversationScope>;
    readonly readConnector: (
        connectionId: string,
        tokenDigest: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<BotConnectorCredential | null>;
    readonly readConnectionLifecycle: (connectionId: string, signal: AbortSignal) => Promise<string | null>;
    readonly recordConnectionUse: (
        credentialId: string,
        connectionId: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<boolean>;
    readonly readInboundCredentialPlanes: (
        botId: string,
        tokenDigest: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<readonly InboundCredentialPlaneRecord[]>;
    readonly readRuntimeExecution: (
        executionId: string,
        tokenDigest: string,
        signal: AbortSignal,
    ) => Promise<BotRuntimeCredential | null>;
}
