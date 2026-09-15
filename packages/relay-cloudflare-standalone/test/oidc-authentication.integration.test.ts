import {
    ExternalIdentityCredential,
    OidcExternalIdentityAuthenticator,
    OidcJwksResponse,
    type OidcJwksSource,
    OidcProviderConfiguration,
    ProjectAuthenticationError,
} from "@moxt-ai/mobius-relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class StatefulJwksSource implements OidcJwksSource {
    #response: OidcJwksResponse;
    requests = 0;

    constructor(response: OidcJwksResponse) {
        this.#response = response;
    }

    readonly replace = (response: OidcJwksResponse): void => {
        this.#response = response;
    };

    readonly read = async (_jwksUrl: URL, signal: AbortSignal): Promise<OidcJwksResponse> => {
        signal.throwIfAborted();
        this.requests += 1;
        return this.#response;
    };
}

function base64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodedJson(value: Readonly<Record<string, unknown>>): string {
    return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function rsaKey(kid: string): Promise<{ readonly jwk: JsonWebKey; readonly privateKey: CryptoKey }> {
    const generated = await crypto.subtle.generateKey(
        { hash: "SHA-256", modulusLength: 2_048, name: "RSASSA-PKCS1-v1_5", publicExponent: new Uint8Array([1, 0, 1]) },
        true,
        ["sign", "verify"],
    );
    if (!("privateKey" in generated)) {
        throw new Error("Expected an RSA key pair");
    }
    const exported = await crypto.subtle.exportKey("jwk", generated.publicKey);
    if (exported instanceof ArrayBuffer) {
        throw new Error("Expected an RSA JSON Web Key");
    }
    return {
        jwk: Object.freeze({ ...exported, alg: "RS256", kid, use: "sig" }),
        privateKey: generated.privateKey,
    };
}

async function jwt(
    key: CryptoKey,
    kid: string,
    claims: Readonly<Record<string, unknown>>,
    algorithm = "RS256",
): Promise<string> {
    const signingInput = `${encodedJson({ alg: algorithm, kid, typ: "JWT" })}.${encodedJson(claims)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function configuration(jwksPath = "/.well-known/jwks.json"): OidcProviderConfiguration {
    return new OidcProviderConfiguration(
        "clerk",
        "https://identity.example.test",
        "mobius-relay",
        new URL(jwksPath, "https://identity.example.test"),
        ["RS256"],
        ["email", "name"],
        300_000,
        30_000,
        5_000,
    );
}

async function errorCode(operation: Promise<unknown>): Promise<string> {
    try {
        await operation;
    } catch (error) {
        if (error instanceof ProjectAuthenticationError) {
            return error.code;
        }
        throw error;
    }
    throw new Error("Expected external authentication to fail");
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe.sequential("OIDC external identity authentication", () => {
    it("Given signed Clerk organization sessions, When tokens are verified, Then v1 and v2 claims identify the organization and malformed, pending, or forged tokens are rejected", async () => {
        const key = await rsaKey("organization-key");
        const otherKey = await rsaKey("organization-key");
        const source = new StatefulJwksSource(new OidcJwksResponse({ keys: [key.jwk] }, 600_000));
        const authenticator = new OidcExternalIdentityAuthenticator(configuration(), source);
        const now = Date.now() / 1_000;
        const claims = {
            aud: "mobius-relay",
            exp: now + 600,
            iat: now,
            iss: "https://identity.example.test",
            sub: "user_member",
        };
        const verify = async (organization: Readonly<Record<string, unknown>>, signingKey = key.privateKey) =>
            await authenticator.authenticate(
                new ExternalIdentityCredential(
                    "clerk",
                    await jwt(signingKey, "organization-key", { ...claims, ...organization }),
                ),
                AbortSignal.timeout(5_000),
            );
        for (const organization of [
            { org_id: "org_team", org_role: "org:admin" },
            { v: 2, sts: "active", o: { id: "org_team", rol: "admin" } },
        ]) {
            expect((await verify(organization)).organization).toEqual({
                kind: "organization",
                id: "org_team",
                role: "org:admin",
            });
        }
        expect((await verify({})).organization).toEqual({ kind: "none" });
        for (const organization of [
            { o: "org_team" },
            { o: { id: "org_team", rol: 123 } },
            { org_id: "ten_local", org_role: "org:admin" },
            { org_id: "org_team" },
        ]) {
            await expect(verify(organization)).rejects.toMatchObject({ code: "external_claims_invalid" });
        }
        await expect(verify({ sts: "pending", o: { id: "org_team", rol: "admin" } })).rejects.toMatchObject({
            code: "external_identity_not_active",
        });
        await expect(verify({ o: { id: "org_team", rol: "admin" } }, otherKey.privateKey)).rejects.toBeInstanceOf(
            ProjectAuthenticationError,
        );
    });

    it("Given an issuer serving signing keys over HTTP, When a Worker authenticates its signed token, Then the identity is verified and redirected key endpoints are rejected", async () => {
        const key = await rsaKey("http-key");
        const signal = AbortSignal.timeout(5_000);
        const published = await fetch("https://identity.example.test/.well-known/jwks.json", {
            method: "PUT",
            body: JSON.stringify({ keys: [key.jwk] }),
            signal,
        });
        expect(published.status).toBe(204);
        const nowSeconds = Math.floor(Date.now() / 1_000);
        const credential = new ExternalIdentityCredential(
            "clerk",
            await jwt(key.privateKey, "http-key", {
                aud: "mobius-relay",
                exp: nowSeconds + 600,
                iat: nowSeconds,
                iss: "https://identity.example.test",
                sub: "http-developer",
            }),
        );
        await expect(
            new OidcExternalIdentityAuthenticator(configuration()).authenticate(credential, signal),
        ).resolves.toMatchObject({ subject: "http-developer", providerId: "clerk" });
        await expect(
            errorCode(
                new OidcExternalIdentityAuthenticator(configuration("/redirect")).authenticate(credential, signal),
            ),
        ).resolves.toBe("external_provider_unavailable");
    });

    it("Given a configured issuer with cached keys, When a valid key rotates, Then signed identities remain bounded to issuer, audience, lifetime, algorithm, and subject", async () => {
        const first = await rsaKey("key-1");
        const second = await rsaKey("key-2");
        const source = new StatefulJwksSource(new OidcJwksResponse({ keys: [first.jwk] }, 600_000));
        const authenticator = new OidcExternalIdentityAuthenticator(configuration(), source);
        const nowSeconds = Math.floor(Date.now() / 1_000);
        const claims = {
            aud: "mobius-relay",
            email: "developer@example.test",
            exp: nowSeconds + 600,
            iat: nowSeconds,
            iss: "https://identity.example.test",
            name: "Mobius Developer",
            unrelated_claim: "ignored",
            sub: "user_123",
        };
        const verified = await authenticator.authenticate(
            new ExternalIdentityCredential("clerk", await jwt(first.privateKey, "key-1", claims)),
            new AbortController().signal,
        );
        expect(verified).toMatchObject({
            authenticatedAtEpochMilliseconds: Date.now(),
            expiresAtEpochMilliseconds: (nowSeconds + 600) * 1_000,
            issuer: "https://identity.example.test",
            providerId: "clerk",
            subject: "user_123",
        });
        expect(Object.fromEntries(verified.metadata)).toEqual({
            email: "developer@example.test",
            name: "Mobius Developer",
        });
        expect(source.requests).toBe(1);

        source.replace(new OidcJwksResponse({ keys: [second.jwk] }, 600_000));
        await expect(
            authenticator.authenticate(
                new ExternalIdentityCredential("clerk", await jwt(second.privateKey, "key-2", claims)),
                new AbortController().signal,
            ),
        ).resolves.toMatchObject({ subject: "user_123" });
        expect(source.requests).toBe(2);
        await expect(
            authenticator.authenticate(
                new ExternalIdentityCredential("clerk", await jwt(second.privateKey, "key-2", claims)),
                new AbortController().signal,
            ),
        ).resolves.toMatchObject({ subject: "user_123" });
        expect(source.requests).toBe(2);
        vi.setSystemTime(Date.now() + 300_001);
        await expect(
            authenticator.authenticate(
                new ExternalIdentityCredential("clerk", await jwt(second.privateKey, "key-2", claims)),
                new AbortController().signal,
            ),
        ).resolves.toMatchObject({ subject: "user_123" });
        expect(source.requests).toBe(3);
        vi.setSystemTime(nowSeconds * 1_000);

        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential(
                        "clerk",
                        await jwt(second.privateKey, "key-2", { ...claims, iss: "https://unknown.example.test" }),
                    ),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_issuer_invalid");
        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential(
                        "clerk",
                        await jwt(second.privateKey, "key-2", { ...claims, aud: "another-service" }),
                    ),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_audience_invalid");
        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential(
                        "clerk",
                        await jwt(second.privateKey, "key-2", { ...claims, exp: nowSeconds - 31 }),
                    ),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_identity_expired");
        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential(
                        "clerk",
                        await jwt(second.privateKey, "key-2", { ...claims, nbf: nowSeconds + 31 }),
                    ),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_identity_not_active");
        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential("clerk", await jwt(second.privateKey, "key-2", claims, "HS256")),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_algorithm_invalid");
        const { sub: _subject, ...claimsWithoutSubject } = claims;
        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential(
                        "clerk",
                        await jwt(second.privateKey, "key-2", claimsWithoutSubject),
                    ),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_subject_invalid");
    });
});
