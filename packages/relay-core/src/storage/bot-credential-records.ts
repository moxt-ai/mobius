import type { BotConnectorCredential, BotRuntimeCredential } from "../entity/bot/bot-access.ts";

export interface InboundCredentialPlaneRecord {
    readonly connection_id: unknown;
    readonly plane: string;
}

export interface BotProjectScopeRecord {
    readonly project_id: string;
}

export interface BotConversationScopeRecord extends BotProjectScopeRecord {
    readonly bot_id: string;
    readonly session_id: string;
}

export abstract class BotProjectScopeLookup {}

export class MissingBotProjectScope extends BotProjectScopeLookup {}

export class FoundBotProjectScope extends BotProjectScopeLookup {
    readonly projectId: string;

    constructor(projectId: string) {
        super();
        this.projectId = projectId;
    }
}

export abstract class BotConversationScopeLookup {}

export class MissingBotConversationScope extends BotConversationScopeLookup {}

export class FoundBotConversationScope extends BotConversationScopeLookup {
    readonly botId: string;
    readonly projectId: string;
    readonly sessionId: string;

    constructor(projectId: string, botId: string, sessionId: string) {
        super();
        this.projectId = projectId;
        this.botId = botId;
        this.sessionId = sessionId;
    }
}

export interface BotCredentialRecords {
    readonly botExists: (botId: string, signal: AbortSignal) => Promise<boolean>;
    readonly botExistsInProject: (botId: string, projectId: string, signal: AbortSignal) => Promise<boolean>;
    readonly readBotProjectScope: (botId: string, signal: AbortSignal) => Promise<BotProjectScopeLookup>;
    readonly readConversationProjectScope: (
        conversationId: string,
        signal: AbortSignal,
    ) => Promise<BotConversationScopeLookup>;
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
