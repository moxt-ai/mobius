import { type MobiusCredentialProvider, MobiusPlatformDeveloperClient } from "@moxt-ai/mobius-sdk/platform";

class SessionCredentialProvider implements MobiusCredentialProvider {
    readonly #getToken: () => Promise<string>;

    constructor(getToken: () => Promise<string>) {
        this.#getToken = getToken;
    }

    readonly credential = async (signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        const token = await this.#getToken();
        signal.throwIfAborted();
        return token;
    };
}

export function createPlatformClient(endpoint: string, getToken: () => Promise<string>): MobiusPlatformDeveloperClient {
    return new MobiusPlatformDeveloperClient({
        authenticationProviderId: "clerk",
        credentialProvider: new SessionCredentialProvider(getToken),
        endpoint,
    });
}
