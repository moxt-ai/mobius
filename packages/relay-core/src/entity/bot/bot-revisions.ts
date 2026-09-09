export interface BotProfileRevision {
    readonly botId: string;
    readonly profileRevisionId: string;
    readonly revisionNumber: number;
    readonly lifecycleRevision: number;
    readonly displayName: string;
    readonly avatarRef: string;
    readonly description: string;
    readonly createdAt: string;
}

export interface BotBehaviorRevision {
    readonly botId: string;
    readonly behaviorRevisionId: string;
    readonly revisionNumber: number;
    readonly instructions: string;
    readonly requiredCapabilities: readonly string[];
    readonly agentConfiguration: Readonly<Record<string, unknown>>;
    readonly contentDigest: string;
    readonly lifecycle: "proposed";
    readonly createdAt: string;
}
