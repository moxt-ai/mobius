import {
    ExpiredPairingStatus,
    PairedPairingStatus,
    PairingDirectoryError,
    PendingPairingStatus,
    parseAgents,
    RevokedPairingStatus,
} from "./pairing.ts";
import type { PairingChannelRow } from "./pairing-records.ts";

export function runtimeRevokedAt(value: unknown): number | null {
    if (value === null) {
        return null;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new PairingDirectoryError("invalid_directory_record", "The Runtime revocation is invalid");
    }
    return value;
}

// The v1 representation is a projection of facts. Passing the clock explicitly
// makes expiry independent of polling, maintenance writes, and component order.
export function projectRuntimePairingStatus(row: PairingChannelRow, now: number) {
    const revokedAt = runtimeRevokedAt(row.revoked_at);
    if (revokedAt !== null) {
        return new RevokedPairingStatus(new Date(revokedAt).toISOString());
    }
    if (row.registration !== null) {
        return new PairedPairingStatus(
            parseAgents(row.registration.agents_json),
            row.channel_id,
            row.registration.machine_name,
            row.registration.workspace_name,
            row.project_id,
            row.runtime_id,
        );
    }
    if (!Number.isSafeInteger(row.expires_at) || row.expires_at < 0) {
        throw new PairingDirectoryError("invalid_directory_record", "The pairing deadline is invalid");
    }
    return row.expires_at <= now
        ? new ExpiredPairingStatus()
        : new PendingPairingStatus(new Date(row.expires_at).toISOString());
}
