import { createSign, generateKeyPairSync } from "node:crypto";
import { ClerkOrganizationGateway } from "../../relay-cloudflare-platform/src/infra/clerk-organization-gateway.ts";
import {
    OidcExternalIdentityAuthenticator,
    OidcJwksResponse,
    type OidcJwksSource,
    OidcProviderConfiguration,
} from "../../relay-core/src/service/authentication/oidc-authentication.ts";

interface FakeClerkOptions {
    readonly audience?: string;
    readonly issuer?: string;
    readonly keyId?: string;
    readonly secret?: string;
}

/**
 * In-memory Clerk service boundary. Production OIDC and organization gateways
 * consume its signed tokens, JWKS source, and Backend API fetch implementation.
 */
export class FakeClerk implements OidcJwksSource {
    readonly audience: string;
    readonly authenticator: OidcExternalIdentityAuthenticator;
    readonly issuer: string;
    readonly organizationGateway: ClerkOrganizationGateway;
    readonly publishableKey: string;
    readonly secret: string;
    requests = 0;

    #available = true;
    #defaultOrganizationId = `org_${crypto.randomUUID().replaceAll("-", "")}`;
    #keyId: string;
    #keys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    readonly #memberships = new Map<string, string>();
    readonly #organizations = new Map<string, string>();
    readonly #redirects = new Map<string, string>();
    #sessionNumber = 0;

    constructor(options: FakeClerkOptions = {}) {
        this.audience = options.audience ?? "mobius-relay";
        this.issuer = options.issuer ?? "https://identity.example.test";
        this.#keyId = options.keyId ?? "fake-clerk-key";
        this.secret = options.secret ?? "sk_test_example";
        this.publishableKey = `pk_test_${Buffer.from(`${new URL(this.issuer).hostname}$`).toString("base64url")}`;
        this.authenticator = new OidcExternalIdentityAuthenticator(this.configuration(), this);
        this.organizationGateway = new ClerkOrganizationGateway(this.secret, this.fetch);
        this.createOrganization(this.defaultOrganizationId, "Developer organization");
    }

    get defaultOrganizationId(): string {
        return this.#defaultOrganizationId;
    }

    get jwk(): JsonWebKey {
        const exported = this.#keys.publicKey.export({ format: "jwk" });
        if (exported.kty !== "RSA" || typeof exported.e !== "string" || typeof exported.n !== "string") {
            throw new Error("Fake Clerk generated an invalid RSA key");
        }
        return Object.freeze({
            alg: "RS256",
            e: exported.e,
            kid: this.#keyId,
            kty: exported.kty,
            n: exported.n,
            use: "sig",
        });
    }

    get keyId(): string {
        return this.#keyId;
    }

    get publicKey(): string {
        return this.#keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    }

    readonly configuration = (): OidcProviderConfiguration =>
        new OidcProviderConfiguration(
            "clerk",
            this.issuer,
            this.audience,
            new URL("/.well-known/jwks.json", this.issuer),
            ["RS256"],
            ["email", "name"],
            300_000,
            30_000,
            5_000,
        );

    readonly createOrganization = (id: string, name: string): void => {
        this.#organizations.set(id, name);
    };

    readonly moveOrganization = (id: string, location: string): void => {
        this.#organizations.delete(id);
        this.#redirects.set(id, location);
    };

    readonly setMembership = (organizationId: string, userId: string, role: string | null): void => {
        const key = `${organizationId}:${userId}`;
        if (role === null) {
            this.#memberships.delete(key);
        } else {
            this.#memberships.set(key, role);
        }
    };

    readonly membership = (organizationId: string, userId: string): string | null =>
        this.#memberships.get(`${organizationId}:${userId}`) ?? null;

    readonly session = (subject: string, organizationId = "", role = "org:admin"): string => {
        const now = Math.floor(Date.now() / 1_000);
        return this.signClaims({
            aud: this.audience,
            exp: now + 600,
            iat: now,
            iss: this.issuer,
            sub: subject,
            ...(organizationId === "" ? {} : { org_id: organizationId, org_role: role }),
        });
    };

    readonly createSession = (
        subject: string,
        origin: string,
        status: "active" | "pending" = "active",
        organizationId: string | null = null,
    ): string => {
        this.#sessionNumber += 1;
        const issuedAt = Date.now() / 1_000;
        return this.signClaims({
            azp: origin,
            exp: issuedAt + 60,
            iat: issuedAt,
            iss: this.issuer,
            nbf: issuedAt,
            sid: `sess_${this.#sessionNumber}`,
            sts: status,
            sub: subject,
            v: 2,
            ...(organizationId === null ? {} : { o: { id: organizationId } }),
        });
    };

    readonly signClaims = (
        claims: Readonly<Record<string, unknown>>,
        header: { readonly algorithm?: string; readonly keyId?: string } = {},
    ): string => {
        const encoded = (value: Readonly<Record<string, unknown>>) =>
            Buffer.from(JSON.stringify(value)).toString("base64url");
        const signingInput = `${encoded({ alg: header.algorithm ?? "RS256", kid: header.keyId ?? this.keyId, typ: "JWT" })}.${encoded(claims)}`;
        const signer = createSign("RSA-SHA256");
        signer.update(signingInput);
        signer.end();
        return `${signingInput}.${Buffer.from(signer.sign(this.#keys.privateKey)).toString("base64url")}`;
    };

    readonly rotateSigningKey = (keyId = this.keyId): void => {
        this.#keys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
        this.#keyId = keyId;
    };

    readonly disable = (): void => {
        this.#available = false;
    };

    readonly reset = (): void => {
        this.#available = true;
        this.#defaultOrganizationId = this.newOrganizationId();
        this.#memberships.clear();
        this.#organizations.clear();
        this.#redirects.clear();
        this.#sessionNumber = 0;
        this.createOrganization(this.defaultOrganizationId, "Developer organization");
    };

    private readonly newOrganizationId = (): string => `org_${crypto.randomUUID().replaceAll("-", "")}`;

    readonly read = async (_jwksUrl: URL, signal: AbortSignal): Promise<OidcJwksResponse> => {
        signal.throwIfAborted();
        if (!this.#available) {
            throw new Error("Fake Clerk is unavailable");
        }
        this.requests += 1;
        return new OidcJwksResponse({ keys: [this.jwk] }, 600_000);
    };

    readonly fetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        request.signal.throwIfAborted();
        if (!this.#available) {
            throw new Error("Fake Clerk is unavailable");
        }
        if (request.headers.get("authorization") !== `Bearer ${this.secret}`) {
            return new Response(null, { status: 401 });
        }
        const url = new URL(request.url);
        const match = /^\/v1\/organizations\/([^/]+)(?:\/(memberships))?$/u.exec(url.pathname);
        if (match === null) {
            return new Response(null, { status: 404 });
        }
        const id = decodeURIComponent(match[1] ?? "");
        const resource = match[2];
        if (resource === undefined) {
            const location = this.#redirects.get(id);
            if (location !== undefined) {
                return Response.redirect(location, 302);
            }
            const name = this.#organizations.get(id);
            return name === undefined ? new Response(null, { status: 404 }) : Response.json({ id, name });
        }
        if (!this.#organizations.has(id)) {
            return new Response(null, { status: 404 });
        }
        if (request.method === "GET") {
            const userId = url.searchParams.get("user_id") ?? "";
            const role = this.#memberships.get(`${id}:${userId}`);
            return Response.json({
                data: role === undefined ? [] : [{ role, public_user_data: { user_id: userId } }],
            });
        }
        if (request.method === "POST") {
            const body = (await request.json()) as { readonly role?: unknown; readonly user_id?: unknown };
            if (typeof body.user_id !== "string" || typeof body.role !== "string") {
                return new Response(null, { status: 400 });
            }
            this.setMembership(id, body.user_id, body.role);
            return Response.json({ role: body.role, public_user_data: { user_id: body.user_id } });
        }
        return new Response(null, { status: 405 });
    };
}
