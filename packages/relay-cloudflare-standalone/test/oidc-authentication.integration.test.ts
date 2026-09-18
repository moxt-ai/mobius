import {
    ExternalIdentityCredential,
    OidcExternalIdentityAuthenticator,
    OidcProviderConfiguration,
    ProjectAuthenticationError,
} from "@moxt-ai/mobius-relay-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClerk } from "../../../tests/infra/clerk.ts";

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
        const clerk = new FakeClerk({ keyId: "organization-key" });
        const otherClerk = new FakeClerk({ keyId: "organization-key" });
        const authenticator = new OidcExternalIdentityAuthenticator(configuration(), clerk);
        const now = Date.now() / 1_000;
        const claims = {
            aud: "mobius-relay",
            exp: now + 600,
            iat: now,
            iss: "https://identity.example.test",
            sub: "user_member",
        };
        const verify = async (organization: Readonly<Record<string, unknown>>, signer = clerk) =>
            await authenticator.authenticate(
                new ExternalIdentityCredential("clerk", signer.signClaims({ ...claims, ...organization })),
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
        await expect(verify({ o: { id: "org_team", rol: "admin" } }, otherClerk)).rejects.toBeInstanceOf(
            ProjectAuthenticationError,
        );
    });

    it("Given an issuer serving signing keys over HTTP, When a Worker authenticates its signed token, Then the identity is verified and redirected key endpoints are rejected", async () => {
        const clerk = new FakeClerk({ keyId: "http-key" });
        const signal = AbortSignal.timeout(5_000);
        const published = await fetch("https://identity.example.test/.well-known/jwks.json", {
            method: "PUT",
            body: JSON.stringify({ keys: [clerk.jwk] }),
            signal,
        });
        expect(published.status).toBe(204);
        const nowSeconds = Math.floor(Date.now() / 1_000);
        const credential = new ExternalIdentityCredential(
            "clerk",
            clerk.signClaims({
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
        const clerk = new FakeClerk({ keyId: "key-1" });
        const authenticator = new OidcExternalIdentityAuthenticator(configuration(), clerk);
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
            new ExternalIdentityCredential("clerk", clerk.signClaims(claims)),
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
        expect(clerk.requests).toBe(1);

        clerk.rotateSigningKey("key-2");
        await expect(
            authenticator.authenticate(
                new ExternalIdentityCredential("clerk", clerk.signClaims(claims)),
                new AbortController().signal,
            ),
        ).resolves.toMatchObject({ subject: "user_123" });
        expect(clerk.requests).toBe(2);
        await expect(
            authenticator.authenticate(
                new ExternalIdentityCredential("clerk", clerk.signClaims(claims)),
                new AbortController().signal,
            ),
        ).resolves.toMatchObject({ subject: "user_123" });
        expect(clerk.requests).toBe(2);
        vi.setSystemTime(Date.now() + 300_001);
        await expect(
            authenticator.authenticate(
                new ExternalIdentityCredential("clerk", clerk.signClaims(claims)),
                new AbortController().signal,
            ),
        ).resolves.toMatchObject({ subject: "user_123" });
        expect(clerk.requests).toBe(3);
        vi.setSystemTime(nowSeconds * 1_000);

        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential(
                        "clerk",
                        clerk.signClaims({ ...claims, iss: "https://unknown.example.test" }),
                    ),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_issuer_invalid");
        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential("clerk", clerk.signClaims({ ...claims, aud: "another-service" })),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_audience_invalid");
        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential("clerk", clerk.signClaims({ ...claims, exp: nowSeconds - 31 })),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_identity_expired");
        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential("clerk", clerk.signClaims({ ...claims, nbf: nowSeconds + 31 })),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_identity_not_active");
        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential("clerk", clerk.signClaims(claims, { algorithm: "HS256" })),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_algorithm_invalid");
        const { sub: _subject, ...claimsWithoutSubject } = claims;
        expect(
            await errorCode(
                authenticator.authenticate(
                    new ExternalIdentityCredential("clerk", clerk.signClaims(claimsWithoutSubject)),
                    new AbortController().signal,
                ),
            ),
        ).toBe("external_subject_invalid");
    });
});
