import type { PairingOperations } from "./pairing-operations.ts";
import type { PairingTenantResolver } from "./pairing-tenant-resolver.ts";

export interface PublicProjectBootstrapAuthorizer {
    readonly authorize: (
        tenantId: string,
        clientFingerprint: string,
        now: number,
        signal: AbortSignal,
    ) => Promise<void>;
}

export class PairingRequestService {
    readonly #pairings: PairingOperations;
    readonly #publicBootstrap: PublicProjectBootstrapAuthorizer;
    readonly #tenants: PairingTenantResolver;

    constructor(
        pairings: PairingOperations,
        tenants: PairingTenantResolver,
        publicBootstrap: PublicProjectBootstrapAuthorizer,
    ) {
        this.#pairings = pairings;
        this.#tenants = tenants;
        this.#publicBootstrap = publicBootstrap;
    }

    readonly createPairing = async (request: Request, signal: AbortSignal) => {
        const tenantId = await this.#tenants.resolve(request, signal);
        signal.throwIfAborted();
        await this.#publicBootstrap.authorize(
            tenantId,
            request.headers.get("cf-connecting-ip") ?? "unavailable",
            Date.now(),
            signal,
        );
        signal.throwIfAborted();
        return this.#pairings.createPairing(tenantId, signal);
    };
}
