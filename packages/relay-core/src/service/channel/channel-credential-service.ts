import type { ChannelCredentialIdentity } from "../../entity/pairing/pairing-records.ts";
import type { ProjectStore } from "../../infra/project-store.ts";

export class ChannelCredentialService {
    readonly #store: ProjectStore;

    constructor(store: ProjectStore) {
        this.#store = store;
    }

    readonly isRuntimeActive = async (
        identity: { readonly projectId: string; readonly runtimeId: string },
        signal: AbortSignal,
    ): Promise<boolean> => {
        const active = await this.#store.isRuntimeActive(identity.runtimeId, signal);
        signal.throwIfAborted();
        return active;
    };

    readonly isActive = async (identity: ChannelCredentialIdentity, signal: AbortSignal): Promise<boolean> => {
        const active = await this.#store.isHostCredentialActive(identity, signal);
        signal.throwIfAborted();
        return active;
    };
}
