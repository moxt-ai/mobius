import {
    type ExternalIdentityAuthenticator,
    type ExternalIdentityCredential,
    ProjectAuthenticationError,
    VerifiedExternalIdentity,
} from "@moxt-ai/mobius-relay-core";

/** Stateful identity-provider boundary: no hosted identity account is needed in tests. */
export class TestDeveloperAuthenticator implements ExternalIdentityAuthenticator {
    #available = true;

    readonly disable = (): void => {
        this.#available = false;
    };

    readonly authenticate = async (
        credential: ExternalIdentityCredential,
        signal: AbortSignal,
    ): Promise<VerifiedExternalIdentity> => {
        signal.throwIfAborted();
        if (!this.#available) {
            throw new ProjectAuthenticationError("external_provider_unavailable", "The provider is unavailable");
        }
        if (credential.providerId !== "clerk" || credential.credential !== "developer-token") {
            throw new ProjectAuthenticationError("external_identity_invalid", "The identity is invalid");
        }
        return new VerifiedExternalIdentity(
            "clerk",
            "https://identity.example.test",
            "developer-1",
            new Map(),
            Date.now(),
            Date.now() + 3_600_000,
        );
    };
}
