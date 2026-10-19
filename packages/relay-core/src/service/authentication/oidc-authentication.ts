import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import {
    type ExternalIdentityAuthenticator,
    type ExternalIdentityCredential,
    ProjectAuthenticationError,
    VerifiedExternalIdentity,
} from "../../entity/authentication/project-authentication.ts";

const MAXIMUM_JWT_LENGTH = 16 * 1024;
const MAXIMUM_JWKS_LENGTH = 256 * 1024;
const MAXIMUM_JWKS_KEYS = 100;
const MAXIMUM_METADATA_VALUE_LENGTH = 500;
const MAXIMUM_SUBJECT_LENGTH = 256;
const OIDC_ALGORITHMS = Object.freeze(["ES256", "PS256", "RS256"]);
const RESERVED_CLAIMS = new Set(["aud", "exp", "iat", "iss", "nbf", "sub"]);

function record(value: unknown, code: string, message: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProjectAuthenticationError(code, message);
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function boundedText(value: unknown, maximumLength: number, code: string, message: string): string {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
        throw new ProjectAuthenticationError(code, message);
    }
    return value;
}

function numericDate(value: unknown, code: string, message: string): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
    ) {
        throw new ProjectAuthenticationError(code, message);
    }
    return value;
}

function decodeBase64Url(value: string, code: string, message: string): Uint8Array {
    if (value.length === 0 || !/^[a-zA-Z0-9_-]+$/.test(value)) {
        throw new ProjectAuthenticationError(code, message);
    }
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    let binary: string;
    try {
        binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    } catch (cause) {
        throw new ProjectAuthenticationError(code, message, { cause });
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function decodeJsonSegment(value: string, code: string, message: string): Readonly<Record<string, unknown>> {
    let decoded: unknown;
    try {
        decoded = JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decodeBase64Url(value, code, message)),
        );
    } catch (cause) {
        if (cause instanceof ProjectAuthenticationError) {
            throw cause;
        }
        throw new ProjectAuthenticationError(code, message, { cause });
    }
    return record(decoded, code, message);
}

function validatedUrl(value: URL, name: string): URL {
    const url = new URL(value.href);
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
        throw new ProjectAuthenticationError("external_provider_configuration_invalid", `The OIDC ${name} is invalid`);
    }
    return url;
}

export class OidcProviderConfiguration {
    readonly allowedAlgorithms: ReadonlySet<string>;
    readonly audience: string;
    readonly clockSkewMilliseconds: number;
    readonly issuer: string;
    readonly jwksUrl: URL;
    readonly maximumCacheLifetimeMilliseconds: number;
    readonly providerId: string;
    readonly safeMetadataClaims: readonly string[];
    readonly validationTimeoutMilliseconds: number;

    constructor(
        providerId: string,
        issuer: string,
        audience: string,
        jwksUrl: URL,
        allowedAlgorithms: readonly string[],
        safeMetadataClaims: readonly string[],
        maximumCacheLifetimeMilliseconds: number,
        clockSkewMilliseconds: number,
        validationTimeoutMilliseconds: number,
    ) {
        if (!isIdentifier(providerId)) {
            throw new ProjectAuthenticationError(
                "external_provider_configuration_invalid",
                "The OIDC provider identifier is invalid",
            );
        }
        let issuerUrl: URL;
        try {
            issuerUrl = validatedUrl(new URL(issuer), "issuer");
        } catch (cause) {
            if (cause instanceof ProjectAuthenticationError) {
                throw cause;
            }
            throw new ProjectAuthenticationError(
                "external_provider_configuration_invalid",
                "The OIDC issuer is invalid",
                { cause },
            );
        }
        if (issuerUrl.search.length > 0) {
            throw new ProjectAuthenticationError(
                "external_provider_configuration_invalid",
                "The OIDC issuer must be an exact HTTPS URL without a query",
            );
        }
        if (audience.length === 0 || audience.length > 512) {
            throw new ProjectAuthenticationError(
                "external_provider_configuration_invalid",
                "The OIDC audience is invalid",
            );
        }
        if (
            allowedAlgorithms.length === 0 ||
            allowedAlgorithms.some((algorithm) => !OIDC_ALGORITHMS.includes(algorithm)) ||
            new Set(allowedAlgorithms).size !== allowedAlgorithms.length
        ) {
            throw new ProjectAuthenticationError(
                "external_provider_configuration_invalid",
                "The OIDC signing algorithms are invalid",
            );
        }
        if (
            safeMetadataClaims.length > 32 ||
            safeMetadataClaims.some(
                (claim) => !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(claim) || RESERVED_CLAIMS.has(claim),
            ) ||
            new Set(safeMetadataClaims).size !== safeMetadataClaims.length
        ) {
            throw new ProjectAuthenticationError(
                "external_provider_configuration_invalid",
                "The OIDC safe metadata claims are invalid",
            );
        }
        if (
            !Number.isSafeInteger(maximumCacheLifetimeMilliseconds) ||
            maximumCacheLifetimeMilliseconds < 0 ||
            maximumCacheLifetimeMilliseconds > 24 * 60 * 60 * 1_000 ||
            !Number.isSafeInteger(clockSkewMilliseconds) ||
            clockSkewMilliseconds < 0 ||
            clockSkewMilliseconds > 5 * 60 * 1_000 ||
            !Number.isSafeInteger(validationTimeoutMilliseconds) ||
            validationTimeoutMilliseconds < 1 ||
            validationTimeoutMilliseconds > 60 * 1_000
        ) {
            throw new ProjectAuthenticationError(
                "external_provider_configuration_invalid",
                "The OIDC time bounds are invalid",
            );
        }
        this.providerId = providerId;
        this.issuer = issuer;
        this.audience = audience;
        this.jwksUrl = validatedUrl(jwksUrl, "JWKS URL");
        this.allowedAlgorithms = new Set(allowedAlgorithms);
        this.safeMetadataClaims = Object.freeze([...safeMetadataClaims]);
        this.maximumCacheLifetimeMilliseconds = maximumCacheLifetimeMilliseconds;
        this.clockSkewMilliseconds = clockSkewMilliseconds;
        this.validationTimeoutMilliseconds = validationTimeoutMilliseconds;
    }
}

export class OidcJwksResponse {
    readonly cacheLifetimeMilliseconds: number;
    readonly document: unknown;

    constructor(document: unknown, cacheLifetimeMilliseconds: number) {
        if (!Number.isSafeInteger(cacheLifetimeMilliseconds) || cacheLifetimeMilliseconds < 0) {
            throw new ProjectAuthenticationError("external_jwks_invalid", "The OIDC JWKS cache lifetime is invalid");
        }
        this.document = document;
        this.cacheLifetimeMilliseconds = cacheLifetimeMilliseconds;
    }
}

export interface OidcJwksSource {
    readonly read: (jwksUrl: URL, signal: AbortSignal) => Promise<OidcJwksResponse>;
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAXIMUM_JWKS_LENGTH) {
        throw new ProjectAuthenticationError("external_jwks_invalid", "The OIDC JWKS response is too large");
    }
    if (response.body === null) {
        return "";
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const result = await reader.read();
            if (result.done) {
                break;
            }
            length += result.value.byteLength;
            if (length > MAXIMUM_JWKS_LENGTH) {
                await reader.cancel();
                throw new ProjectAuthenticationError("external_jwks_invalid", "The OIDC JWKS response is too large");
            }
            chunks.push(result.value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch (cause) {
        throw new ProjectAuthenticationError("external_jwks_invalid", "The OIDC JWKS response is invalid", {
            cause,
        });
    }
}

function cacheLifetime(response: Response): number {
    const cacheControl = response.headers.get("cache-control") ?? "";
    for (const directive of cacheControl.split(",")) {
        const normalized = directive.trim().toLowerCase();
        if (!normalized.startsWith("max-age=")) {
            continue;
        }
        const value = normalized.slice("max-age=".length);
        if (/^[0-9]+$/.test(value)) {
            const seconds = Number(value);
            if (Number.isSafeInteger(seconds)) {
                return seconds * 1_000;
            }
        }
    }
    return 0;
}

export class FetchOidcJwksSource implements OidcJwksSource {
    readonly read = async (jwksUrl: URL, signal: AbortSignal): Promise<OidcJwksResponse> => {
        signal.throwIfAborted();
        let response: Response;
        try {
            response = await fetch(jwksUrl, {
                headers: { accept: "application/json" },
                // Workers supports manual redirects; the response check below rejects every 3xx.
                redirect: "manual",
                signal,
            });
        } catch (cause) {
            signal.throwIfAborted();
            throw new ProjectAuthenticationError(
                "external_provider_unavailable",
                "The OIDC JWKS endpoint is unavailable",
                { cause },
            );
        }
        if (!response.ok) {
            throw new ProjectAuthenticationError(
                "external_provider_unavailable",
                "The OIDC JWKS endpoint is unavailable",
            );
        }
        const encoded = await boundedResponseText(response, signal);
        let document: unknown;
        try {
            document = JSON.parse(encoded);
        } catch (cause) {
            throw new ProjectAuthenticationError("external_jwks_invalid", "The OIDC JWKS response is invalid", {
                cause,
            });
        }
        return new OidcJwksResponse(document, cacheLifetime(response));
    };
}

abstract class OidcSigningAlgorithm {
    abstract readonly importKey: (value: Readonly<Record<string, unknown>>) => Promise<CryptoKey>;
    abstract readonly keyType: string;
    abstract readonly name: string;
    abstract readonly verify: (key: CryptoKey, signature: Uint8Array, input: Uint8Array) => Promise<boolean>;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy.buffer;
}

function rsaJwk(value: Readonly<Record<string, unknown>>, algorithm: string): JsonWebKey {
    return {
        alg: algorithm,
        e: boundedText(value["e"], 16, "external_jwks_invalid", "The OIDC signing key is invalid"),
        ext: true,
        key_ops: ["verify"],
        kty: "RSA",
        n: boundedText(value["n"], 2_048, "external_jwks_invalid", "The OIDC signing key is invalid"),
    };
}

class Rs256SigningAlgorithm extends OidcSigningAlgorithm {
    readonly keyType = "RSA";
    readonly name = "RS256";
    readonly importKey = async (value: Readonly<Record<string, unknown>>): Promise<CryptoKey> =>
        await crypto.subtle.importKey(
            "jwk",
            rsaJwk(value, this.name),
            { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
            false,
            ["verify"],
        );
    readonly verify = async (key: CryptoKey, signature: Uint8Array, input: Uint8Array): Promise<boolean> =>
        await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, ownedBuffer(signature), ownedBuffer(input));
}

class Ps256SigningAlgorithm extends OidcSigningAlgorithm {
    readonly keyType = "RSA";
    readonly name = "PS256";
    readonly importKey = async (value: Readonly<Record<string, unknown>>): Promise<CryptoKey> =>
        await crypto.subtle.importKey("jwk", rsaJwk(value, this.name), { hash: "SHA-256", name: "RSA-PSS" }, false, [
            "verify",
        ]);
    readonly verify = async (key: CryptoKey, signature: Uint8Array, input: Uint8Array): Promise<boolean> =>
        await crypto.subtle.verify(
            { name: "RSA-PSS", saltLength: 32 },
            key,
            ownedBuffer(signature),
            ownedBuffer(input),
        );
}

class Es256SigningAlgorithm extends OidcSigningAlgorithm {
    readonly keyType = "EC";
    readonly name = "ES256";
    readonly importKey = async (value: Readonly<Record<string, unknown>>): Promise<CryptoKey> => {
        if (value["crv"] !== "P-256") {
            throw new ProjectAuthenticationError("external_jwks_invalid", "The OIDC signing key is invalid");
        }
        const jwk: JsonWebKey = {
            alg: this.name,
            crv: "P-256",
            ext: true,
            key_ops: ["verify"],
            kty: "EC",
            x: boundedText(value["x"], 128, "external_jwks_invalid", "The OIDC signing key is invalid"),
            y: boundedText(value["y"], 128, "external_jwks_invalid", "The OIDC signing key is invalid"),
        };
        return await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    };
    readonly verify = async (key: CryptoKey, signature: Uint8Array, input: Uint8Array): Promise<boolean> =>
        await crypto.subtle.verify({ hash: "SHA-256", name: "ECDSA" }, key, ownedBuffer(signature), ownedBuffer(input));
}

function signingAlgorithm(name: string): OidcSigningAlgorithm {
    if (name === "RS256") {
        return new Rs256SigningAlgorithm();
    }
    if (name === "PS256") {
        return new Ps256SigningAlgorithm();
    }
    if (name === "ES256") {
        return new Es256SigningAlgorithm();
    }
    throw new ProjectAuthenticationError("external_algorithm_invalid", "The OIDC signing algorithm is not allowed");
}

class OidcVerificationKey {
    readonly algorithm: OidcSigningAlgorithm;
    readonly key: CryptoKey;
    readonly keyId: string;

    constructor(keyId: string, algorithm: OidcSigningAlgorithm, key: CryptoKey) {
        this.keyId = keyId;
        this.algorithm = algorithm;
        this.key = key;
    }
}

abstract class OidcKeyCacheState {
    abstract readonly has: (keyId: string, algorithm: string) => boolean;
    abstract readonly isFresh: (now: number) => boolean;
    abstract readonly read: (keyId: string, algorithm: string) => OidcVerificationKey;
}

class EmptyOidcKeyCacheState extends OidcKeyCacheState {
    readonly has = (_keyId: string, _algorithm: string): boolean => false;
    readonly isFresh = (_now: number): boolean => false;
    readonly read = (_keyId: string, _algorithm: string): OidcVerificationKey => {
        throw new ProjectAuthenticationError("external_signing_key_unknown", "The OIDC signing key is unknown");
    };
}

class ReadyOidcKeyCacheState extends OidcKeyCacheState {
    readonly #expiresAt: number;
    readonly #keys: ReadonlyMap<string, OidcVerificationKey>;

    constructor(keys: ReadonlyMap<string, OidcVerificationKey>, expiresAt: number) {
        super();
        this.#keys = new Map(keys);
        this.#expiresAt = expiresAt;
    }

    readonly has = (keyId: string, algorithm: string): boolean => this.#keys.has(`${keyId}\u0000${algorithm}`);
    readonly isFresh = (now: number): boolean => now < this.#expiresAt;
    readonly read = (keyId: string, algorithm: string): OidcVerificationKey => {
        const key = this.#keys.get(`${keyId}\u0000${algorithm}`);
        if (key === undefined) {
            throw new ProjectAuthenticationError("external_signing_key_unknown", "The OIDC signing key is unknown");
        }
        return key;
    };
}

class DecodedOidcJwt {
    readonly algorithm: string;
    readonly keyId: string;
    readonly payloadSegment: string;
    readonly signature: Uint8Array;
    readonly signingInput: Uint8Array;

    constructor(value: string) {
        if (value.length === 0 || value.length > MAXIMUM_JWT_LENGTH) {
            throw new ProjectAuthenticationError("external_credential_invalid", "The OIDC credential is invalid");
        }
        const segments = value.split(".");
        if (segments.length !== 3) {
            throw new ProjectAuthenticationError("external_credential_invalid", "The OIDC credential is invalid");
        }
        const headerSegment = segments[0] ?? "";
        this.payloadSegment = segments[1] ?? "";
        const signatureSegment = segments[2] ?? "";
        const header = decodeJsonSegment(
            headerSegment,
            "external_credential_invalid",
            "The OIDC credential header is invalid",
        );
        this.algorithm = boundedText(
            header["alg"],
            16,
            "external_algorithm_invalid",
            "The OIDC signing algorithm is invalid",
        );
        this.keyId = boundedText(
            header["kid"],
            256,
            "external_signing_key_unknown",
            "The OIDC signing key identifier is invalid",
        );
        this.signature = decodeBase64Url(
            signatureSegment,
            "external_credential_invalid",
            "The OIDC credential signature is invalid",
        );
        this.signingInput = new TextEncoder().encode(`${headerSegment}.${this.payloadSegment}`);
    }
}

function audienceMatches(value: unknown, expected: string): boolean {
    if (typeof value === "string") {
        return value === expected;
    }
    if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
        return false;
    }
    return value.includes(expected);
}

export class OidcExternalIdentityAuthenticator implements ExternalIdentityAuthenticator {
    #cache: OidcKeyCacheState = new EmptyOidcKeyCacheState();
    readonly #configuration: OidcProviderConfiguration;
    readonly #source: OidcJwksSource;

    constructor(configuration: OidcProviderConfiguration, source: OidcJwksSource = new FetchOidcJwksSource()) {
        this.#configuration = configuration;
        this.#source = source;
    }

    readonly authenticate = async (
        credential: ExternalIdentityCredential,
        signal: AbortSignal,
    ): Promise<VerifiedExternalIdentity> => {
        signal.throwIfAborted();
        if (credential.providerId !== this.#configuration.providerId) {
            throw new ProjectAuthenticationError(
                "external_provider_invalid",
                "The external credential belongs to another provider",
            );
        }
        const deadline = AbortSignal.timeout(this.#configuration.validationTimeoutMilliseconds);
        const boundedSignal = AbortSignal.any([signal, deadline]);
        try {
            const decoded = new DecodedOidcJwt(credential.credential);
            if (!this.#configuration.allowedAlgorithms.has(decoded.algorithm)) {
                throw new ProjectAuthenticationError(
                    "external_algorithm_invalid",
                    "The OIDC signing algorithm is not allowed",
                );
            }
            const key = await this.verificationKey(decoded.keyId, decoded.algorithm, Date.now(), boundedSignal);
            let validSignature: boolean;
            try {
                validSignature = await key.algorithm.verify(key.key, decoded.signature, decoded.signingInput);
            } catch (cause) {
                throw new ProjectAuthenticationError(
                    "external_signature_invalid",
                    "The OIDC credential signature is invalid",
                    { cause },
                );
            }
            if (!validSignature) {
                throw new ProjectAuthenticationError(
                    "external_signature_invalid",
                    "The OIDC credential signature is invalid",
                );
            }
            return this.verifiedIdentity(decoded.payloadSegment);
        } catch (cause) {
            signal.throwIfAborted();
            if (boundedSignal.aborted) {
                throw new ProjectAuthenticationError(
                    "external_provider_timeout",
                    "External identity verification timed out",
                    { cause },
                );
            }
            if (cause instanceof ProjectAuthenticationError) {
                throw cause;
            }
            throw new ProjectAuthenticationError(
                "external_provider_unavailable",
                "External identity verification is unavailable",
                { cause },
            );
        }
    };

    private readonly verificationKey = async (
        keyId: string,
        algorithm: string,
        now: number,
        signal: AbortSignal,
    ): Promise<OidcVerificationKey> => {
        if (this.#cache.isFresh(now) && this.#cache.has(keyId, algorithm)) {
            return this.#cache.read(keyId, algorithm);
        }
        await this.refreshKeys(now, signal);
        if (!this.#cache.has(keyId, algorithm)) {
            throw new ProjectAuthenticationError("external_signing_key_unknown", "The OIDC signing key is unknown");
        }
        return this.#cache.read(keyId, algorithm);
    };

    private readonly refreshKeys = async (now: number, signal: AbortSignal): Promise<void> => {
        const response = await this.#source.read(new URL(this.#configuration.jwksUrl.href), signal);
        signal.throwIfAborted();
        const document = record(response.document, "external_jwks_invalid", "The OIDC JWKS response is invalid");
        const values = document["keys"];
        if (!Array.isArray(values) || values.length === 0 || values.length > MAXIMUM_JWKS_KEYS) {
            throw new ProjectAuthenticationError("external_jwks_invalid", "The OIDC JWKS response is invalid");
        }
        const keys = new Map<string, OidcVerificationKey>();
        for (const value of values) {
            const jwk = record(value, "external_jwks_invalid", "The OIDC signing key is invalid");
            const keyId = boundedText(
                jwk["kid"],
                256,
                "external_jwks_invalid",
                "The OIDC signing key identifier is invalid",
            );
            const use = jwk["use"];
            if (use !== undefined && use !== "sig") {
                continue;
            }
            const keyOperations = jwk["key_ops"];
            if (
                keyOperations !== undefined &&
                (!Array.isArray(keyOperations) ||
                    keyOperations.some((operation) => typeof operation !== "string") ||
                    !keyOperations.includes("verify"))
            ) {
                continue;
            }
            const declaredAlgorithm = jwk["alg"];
            const candidates =
                typeof declaredAlgorithm === "string"
                    ? [declaredAlgorithm]
                    : [...this.#configuration.allowedAlgorithms];
            for (const candidate of candidates) {
                if (!this.#configuration.allowedAlgorithms.has(candidate)) {
                    continue;
                }
                const algorithm = signingAlgorithm(candidate);
                if (jwk["kty"] !== algorithm.keyType) {
                    continue;
                }
                const index = `${keyId}\u0000${algorithm.name}`;
                if (keys.has(index)) {
                    throw new ProjectAuthenticationError(
                        "external_jwks_invalid",
                        "The OIDC JWKS contains a duplicate signing key",
                    );
                }
                let imported: CryptoKey;
                try {
                    imported = await algorithm.importKey(jwk);
                } catch (cause) {
                    if (cause instanceof ProjectAuthenticationError) {
                        throw cause;
                    }
                    throw new ProjectAuthenticationError("external_jwks_invalid", "The OIDC signing key is invalid", {
                        cause,
                    });
                }
                keys.set(index, new OidcVerificationKey(keyId, algorithm, imported));
            }
        }
        if (keys.size === 0) {
            throw new ProjectAuthenticationError("external_jwks_invalid", "The OIDC JWKS has no permitted signing key");
        }
        const lifetime = Math.min(
            response.cacheLifetimeMilliseconds,
            this.#configuration.maximumCacheLifetimeMilliseconds,
        );
        this.#cache = new ReadyOidcKeyCacheState(keys, now + lifetime);
    };

    private readonly verifiedIdentity = (payloadSegment: string): VerifiedExternalIdentity => {
        const claims = decodeJsonSegment(
            payloadSegment,
            "external_claims_invalid",
            "The OIDC credential claims are invalid",
        );
        if (claims["iss"] !== this.#configuration.issuer) {
            throw new ProjectAuthenticationError("external_issuer_invalid", "The OIDC credential issuer is invalid");
        }
        if (!audienceMatches(claims["aud"], this.#configuration.audience)) {
            throw new ProjectAuthenticationError(
                "external_audience_invalid",
                "The OIDC credential audience is invalid",
            );
        }
        const subject = boundedText(
            claims["sub"],
            MAXIMUM_SUBJECT_LENGTH,
            "external_subject_invalid",
            "The OIDC credential subject is invalid",
        );
        const expiresAt =
            numericDate(claims["exp"], "external_claims_invalid", "The OIDC credential expiry is invalid") * 1_000;
        const issuedAt =
            numericDate(claims["iat"], "external_claims_invalid", "The OIDC credential issue time is invalid") * 1_000;
        const notBefore =
            claims["nbf"] === undefined
                ? 0
                : numericDate(
                      claims["nbf"],
                      "external_claims_invalid",
                      "The OIDC credential not-before time is invalid",
                  ) * 1_000;
        const now = Date.now();
        if (expiresAt + this.#configuration.clockSkewMilliseconds <= now) {
            throw new ProjectAuthenticationError("external_identity_expired", "The OIDC credential has expired");
        }
        if (notBefore > now + this.#configuration.clockSkewMilliseconds) {
            throw new ProjectAuthenticationError(
                "external_identity_not_active",
                "The OIDC credential is not active yet",
            );
        }
        if (issuedAt > now + this.#configuration.clockSkewMilliseconds || issuedAt >= expiresAt) {
            throw new ProjectAuthenticationError(
                "external_claims_invalid",
                "The OIDC credential issue time is invalid",
            );
        }
        const metadata = new Map<string, string>();
        for (const claim of this.#configuration.safeMetadataClaims) {
            const value = claims[claim];
            if (value === undefined) {
                continue;
            }
            if (typeof value !== "string" || value.length > MAXIMUM_METADATA_VALUE_LENGTH) {
                throw new ProjectAuthenticationError(
                    "external_claims_invalid",
                    "An OIDC safe metadata claim is invalid",
                );
            }
            metadata.set(claim, value);
        }
        let organization: VerifiedExternalIdentity["organization"] = { kind: "none" };
        if (this.#configuration.providerId === "clerk") {
            const organizationClaims =
                claims["o"] === undefined
                    ? null
                    : record(claims["o"], "external_claims_invalid", "The Clerk organization is invalid");
            const id = organizationClaims === null ? claims["org_id"] : organizationClaims["id"];
            const role = organizationClaims === null ? claims["org_role"] : organizationClaims["rol"];
            if (claims["sts"] === "pending") {
                throw new ProjectAuthenticationError("external_identity_not_active", "The Clerk session is pending");
            }
            if (id !== undefined && id !== null) {
                if (
                    typeof id !== "string" ||
                    !/^org_[a-zA-Z0-9]+$/.test(id) ||
                    id.length > 128 ||
                    typeof role !== "string" ||
                    !/^(org:)?[a-zA-Z0-9_-]+$/.test(role)
                ) {
                    throw new ProjectAuthenticationError(
                        "external_claims_invalid",
                        "The Clerk organization is invalid",
                    );
                }
                organization = { kind: "organization", id, role: role.startsWith("org:") ? role : `org:${role}` };
            }
        }
        return new VerifiedExternalIdentity(
            this.#configuration.providerId,
            this.#configuration.issuer,
            subject,
            metadata,
            issuedAt,
            expiresAt,
            organization,
        );
    };
}
