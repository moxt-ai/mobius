import type { PairingOperations } from "./pairing-operations.ts";
import type { PairingTenantResolver } from "./pairing-tenant-resolver.ts";

export class PairingRequestService {
    readonly #pairings: PairingOperations;
    readonly #tenants: PairingTenantResolver;

    constructor(pairings: PairingOperations, tenants: PairingTenantResolver) {
        this.#pairings = pairings;
        this.#tenants = tenants;
    }

    readonly createPairing = async (request: Request, signal: AbortSignal) => {
        const tenantId = await this.#tenants.resolve(request, signal);
        signal.throwIfAborted();
        return this.#pairings.createPairing(tenantId, signal);
    };
}
