import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";

export interface PairingTenantResolver {
    readonly resolve: (request: Request, signal: AbortSignal) => Promise<string>;
}

export class ConfiguredPairingTenantResolver implements PairingTenantResolver {
    private readonly tenantId: unknown;

    constructor(tenantId: unknown) {
        this.tenantId = tenantId;
    }

    readonly resolve = async (_request: Request, signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        if (typeof this.tenantId !== "string") {
            throw new PairingDirectoryError("pairing_tenant_unavailable", "The pairing tenant is not configured");
        }
        try {
            return validateIdentifier(this.tenantId, "tenant_id");
        } catch (cause) {
            throw new PairingDirectoryError("pairing_tenant_unavailable", "The pairing tenant is not configured", {
                cause,
            });
        }
    };
}
