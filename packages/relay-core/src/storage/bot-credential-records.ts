import type {
    BotConnectorCredential,
    BotOwnerCredential,
    BotRuntimeCredential,
    ProjectOwnerCredential,
} from "../entity/bot/bot-access.ts";

export interface BotCredentialRecords {
    readonly readProjectOwner: (
        projectId: string,
        tokenDigest: string,
        signal: AbortSignal,
    ) => Promise<ProjectOwnerCredential | null>;
    readonly readBotOwner: (
        botId: string,
        tokenDigest: string,
        signal: AbortSignal,
    ) => Promise<BotOwnerCredential | null>;
    readonly botExists: (botId: string, signal: AbortSignal) => Promise<boolean>;
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
    readonly findInboundConnection: (botId: string, tokenDigest: string, signal: AbortSignal) => Promise<string | null>;
    readonly readRuntimeExecution: (
        executionId: string,
        tokenDigest: string,
        signal: AbortSignal,
    ) => Promise<BotRuntimeCredential | null>;
}
