export interface SessionRetentionScope {
    readonly scopeKey: string;
    readonly projectId: string;
    readonly sessionId: string;
}

export interface SessionRetentionReceipt {
    readonly eventId: string;
    readonly payloadHash: string;
    readonly recordedAt: number;
    readonly sequenceNumber: number;
    readonly sourceId: string;
    readonly sourceKind: "attempt" | "runtime";
    readonly sourceSeq: string;
}

export interface SessionRetentionScrub {
    readonly receipts: readonly SessionRetentionReceipt[];
    readonly turns: readonly { readonly id: string; readonly commandJson: string }[];
    readonly attemptIds: readonly string[];
    readonly interactionIds: readonly string[];
    readonly workIds: readonly string[];
}
