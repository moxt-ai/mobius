export interface RuntimeConnectionIdentity {
    readonly runtimeId: string;
    readonly connectionEpoch: number;
    readonly connectionId: string;
}

export interface RuntimeDisconnect extends RuntimeConnectionIdentity {
    readonly projectId: string;
    readonly disconnectedAt: number;
}

/**
 * One Session that still has work outstanding on the disconnecting Runtime.
 *
 * The Session holds the Attempt state, so only these Sessions need revisiting when a Runtime drops. Carrying
 * the recording epoch keeps a resumed sweep from touching a Session a newer connection has since taken over.
 */
export interface RuntimeDisconnectTarget {
    readonly connectionEpoch: number;
    readonly sessionId: string;
}
