import type { ChannelCredentialIdentity, ChannelCredentialStorage } from "../../storage/channel-credential-storage.ts";

export class ChannelCredentialService {
    readonly #storage: ChannelCredentialStorage;

    constructor(storage: ChannelCredentialStorage) {
        this.#storage = storage;
    }

    readonly isActive = async (identity: ChannelCredentialIdentity, signal: AbortSignal): Promise<boolean> => {
        const row = await this.#storage.readActive(identity, signal);
        signal.throwIfAborted();
        return row?.active === 1;
    };
}
