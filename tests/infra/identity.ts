import {
    type ExternalIdentityAuthenticator,
    type ExternalIdentityCredential,
    ProjectAuthenticationError,
    VerifiedExternalIdentity,
} from "@moxt-ai/mobius-relay-core";

/** Stateful identity-provider boundary: no hosted identity account is needed in tests. */
export class TestDeveloperAuthenticator implements ExternalIdentityAuthenticator {
    #available = true;
    readonly #organizationId = `org_${crypto.randomUUID().replaceAll("-", "")}`;
    readonly #sessions = new Map<
        string,
        { readonly subject: string; readonly organizationId: string; readonly role: string }
    >();

    readonly session = (subject: string, organizationId: string, role = "org:admin"): string => {
        const token = crypto.randomUUID();
        this.#sessions.set(token, { subject, organizationId, role });
        return token;
    };

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
        const session = this.#sessions.get(credential.credential);
        if (
            credential.providerId !== "clerk" ||
            (credential.credential !== "developer-token" && session === undefined)
        ) {
            throw new ProjectAuthenticationError("external_identity_invalid", "The identity is invalid");
        }
        return new VerifiedExternalIdentity(
            "clerk",
            "https://identity.example.test",
            session?.subject ?? "developer-1",
            new Map(),
            Date.now(),
            Date.now() + 3_600_000,
            session?.organizationId === ""
                ? { kind: "none" }
                : {
                      kind: "organization",
                      id: session?.organizationId ?? this.#organizationId,
                      role: session?.role ?? "org:admin",
                  },
        );
    };
}
