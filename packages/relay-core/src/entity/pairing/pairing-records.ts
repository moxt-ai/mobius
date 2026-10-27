interface PairingScopeRow {
    readonly channel_id: string;
    readonly runtime_id: string;
    readonly project_id: string;
}

export interface RuntimeRegistrationRow {
    readonly claimed_at: number;
    readonly agents_json: string;
    readonly machine_name: string;
    readonly workspace_name: string;
}

export interface RuntimeDirectoryRow extends PairingScopeRow {
    readonly revoked_at: unknown;
    readonly registration: RuntimeRegistrationRow | null;
}

export interface PairingChannelRow extends RuntimeDirectoryRow {
    readonly pairing_id: string;
    readonly expires_at: number;
}

export interface RuntimePairingRow extends PairingScopeRow {
    readonly pairing_id: string;
    readonly pairing_code_hash: string;
    readonly poll_token_hash: string;
    readonly expires_at: number;
    readonly created_by_owner_credential_id: unknown;
}

export interface RuntimePairingAudit {
    readonly auditId: string;
    readonly projectId: string;
    readonly pairingId: string;
    readonly runtimeId: string;
    readonly actorKind: string;
    readonly actorId: string;
    readonly action:
        | "runtime_pairing.requested"
        | "runtime_pairing.claimed"
        | "runtime_pairing.expired"
        | "runtime_pairing.revoked"
        | "runtime_pairing.rejected";
    readonly details: Readonly<Record<string, string>>;
    readonly recordedAt: number;
}
