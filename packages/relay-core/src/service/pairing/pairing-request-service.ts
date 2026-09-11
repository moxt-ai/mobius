import type { PairingOperations } from "./pairing-operations.ts";

export interface PublicProjectBootstrapAuthorizer {
    readonly authorize: (clientFingerprint: string, now: number, signal: AbortSignal) => Promise<void>;
}

export class PairingRequestService {
    readonly #pairings: PairingOperations;
    readonly #publicBootstrap: PublicProjectBootstrapAuthorizer;

    constructor(pairings: PairingOperations, publicBootstrap: PublicProjectBootstrapAuthorizer) {
        this.#pairings = pairings;
        this.#publicBootstrap = publicBootstrap;
    }

    readonly createPairing = async (request: Request, signal: AbortSignal) => {
        signal.throwIfAborted();
        await this.#publicBootstrap.authorize(
            request.headers.get("cf-connecting-ip") ?? "unavailable",
            Date.now(),
            signal,
        );
        signal.throwIfAborted();
        return this.#pairings.createPairing(signal);
    };
}
