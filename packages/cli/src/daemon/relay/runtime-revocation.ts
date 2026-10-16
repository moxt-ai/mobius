const runtimeRevocationCloseCode = 1008;
const runtimeRevocationCloseReason = "Runtime revoked";

/**
 * A Runtime relay revocation is terminal for this local Runtime.  It is normalized from the
 * deployed Relay close record so callers never need to branch on transport text.
 */
export class RuntimeRelayRevokedError extends Error {
    readonly code = "runtime_relay_revoked";
    readonly closeCode: number;
    readonly closeReason: string;

    constructor(closeCode: number, closeReason: string, options: ErrorOptions = {}) {
        super("The Runtime was revoked by the Relay", options);
        this.closeCode = closeCode;
        this.closeReason = closeReason;
        this.name = "RuntimeRelayRevokedError";
    }
}

export function isRuntimeRelayRevocation(closeCode: number, closeReason: string): boolean {
    return closeCode === runtimeRevocationCloseCode && closeReason === runtimeRevocationCloseReason;
}
