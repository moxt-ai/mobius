import type { BotConnectorCredential, BotRuntimeCredential } from "../entity/bot/bot-access.ts";

export interface InboundCredentialPlaneRecord {
    readonly connection_id: unknown;
    readonly plane: string;
}

export interface BotCredentialRecords {
    readonly botExists: (botId: string, signal: AbortSignal) => Promise<boolean>;
    readonly botExistsInProject: (
        botId: string,
        tenantId: string,
        projectId: string,
        signal: AbortSignal,
    ) => Promise<boolean>;
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
