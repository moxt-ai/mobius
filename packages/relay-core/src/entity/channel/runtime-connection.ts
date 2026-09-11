export interface RuntimeConnectionIdentity {
    readonly runtimeId: string;
    readonly connectionEpoch: number;
    readonly connectionId: string;
}

export interface RuntimeDisconnect extends RuntimeConnectionIdentity {
    readonly projectId: string;
    readonly disconnectedAt: number;
    readonly progress:
        | { readonly kind: "listing" }
        | { readonly kind: "disconnecting"; readonly remaining: readonly string[] };
}
