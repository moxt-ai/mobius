export interface SessionRetentionScope {
    readonly scopeKey: string;
    readonly projectId: string;
    readonly sessionId: string;
}

export interface SessionRetentionScrub {
    readonly turns: readonly { readonly id: string; readonly commandJson: string }[];
    readonly attemptIds: readonly string[];
    readonly interactionIds: readonly string[];
    readonly workIds: readonly string[];
}
