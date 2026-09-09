import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";
import type { PairingIdentityCredential } from "../../entity/pairing/pairing-identity.ts";
import { DatabaseError } from "../../infra/sql-database.ts";
import type { TenantContext, TenantShardingDirectory } from "../../infra/tenant-sharding-directory.ts";
import type { PairingIdentityStorage } from "../../storage/pairing-identity-storage.ts";

export class PairingIdentityService {
    readonly #storage: PairingIdentityStorage;
    readonly #tenants: TenantShardingDirectory;
    constructor(storage: PairingIdentityStorage, tenants: TenantShardingDirectory) {
        this.#storage = storage;
        this.#tenants = tenants;
    }

    readonly authenticateTenant = async (
        credential: PairingIdentityCredential,
        signal: AbortSignal,
    ): Promise<TenantContext> => {
        const identity = await this.authenticate(credential, signal);
        const tenant = await this.#tenants.resolve(identity.tenantId, signal);
        signal.throwIfAborted();
        if (!this.#storage.matchesPlacement(identity.sourceId, tenant)) {
            throw new PairingDirectoryError("directory_unavailable", "Workspace storage is unavailable");
        }
        return tenant;
    };

    private readonly authenticate = async (credential: PairingIdentityCredential, signal: AbortSignal) => {
        signal.throwIfAborted();
        try {
            const matches: { readonly tenantId: string; readonly sourceId: string }[] = [];
            for (const { row, sourceId } of await this.#storage.find(credential, signal)) {
                signal.throwIfAborted();
                const tenantId = row["tenant_id"];
                if (typeof tenantId !== "string") {
                    throw new PairingDirectoryError("invalid_directory_record", "The tenant directory is invalid");
                }
                if (credential.kind === "project") {
                    const revokedAt = row["revoked_at"];
                    const expiresAt = row["expires_at"];
                    if (
                        (revokedAt !== null && (typeof revokedAt !== "number" || !Number.isSafeInteger(revokedAt))) ||
                        (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)))
                    ) {
                        throw new PairingDirectoryError("invalid_directory_record", "The tenant directory is invalid");
                    }
                    if (revokedAt !== null) {
                        throw new PairingDirectoryError("credential_revoked", "The browser credential was revoked");
                    }
                    if (expiresAt !== null && expiresAt <= Date.now()) {
                        throw new PairingDirectoryError("credential_expired", "The browser credential expired");
                    }
                }
                matches.push({ tenantId: validateIdentifier(tenantId, "tenant_id"), sourceId });
            }
            const match = matches[0];
            if (matches.length !== 1 || match === undefined) {
                const code =
                    credential.kind === "pairing"
                        ? "pairing_not_found"
                        : credential.kind === "pairing-code"
                          ? "invalid_pairing_code"
                          : credential.kind === "grant"
                            ? "access_grant_invalid"
                            : "unauthorized";
                throw new PairingDirectoryError(code, "A valid pairing or channel credential is required");
            }
            return match;
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof PairingDirectoryError) {
                throw cause;
            }
            if (cause instanceof DatabaseError && cause.code === "database_timeout") {
                throw new PairingDirectoryError("directory_timeout", "The tenant directory timed out", { cause });
            }
            throw new PairingDirectoryError("directory_unavailable", "The tenant directory is unavailable", { cause });
        }
    };
}
