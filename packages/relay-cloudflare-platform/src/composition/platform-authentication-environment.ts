import {
    ExternalIdentityAuthenticatorRegistry,
    OidcExternalIdentityAuthenticator,
    OidcProviderConfiguration,
    ProjectAuthenticationError,
    RegisteredExternalIdentityAuthenticator,
} from "@moxt-ai/mobius-relay-core";
import { PlatformAuthenticationConfiguration } from "../entity/platform-control-plane.ts";

const DEFAULT_ALLOWED_ALGORITHMS = Object.freeze(["RS256"]);
const DEFAULT_SAFE_METADATA_CLAIMS = Object.freeze(["email", "name"]);

export interface PlatformAuthenticationEnvironment {
    readonly MOBIUS_PLATFORM_ALLOWED_ORIGINS: string;
    readonly MOBIUS_PLATFORM_OIDC_PROVIDERS: string;
    readonly MOBIUS_PLATFORM_OPERATOR_SUBJECTS: string;
}

function decodedJson(value: string, name: string): unknown {
    try {
        return JSON.parse(value);
    } catch (cause) {
        throw new ProjectAuthenticationError(
            "external_provider_configuration_invalid",
            `The ${name} configuration is invalid`,
            { cause },
        );
    }
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProjectAuthenticationError(
            "external_provider_configuration_invalid",
            `The ${name} configuration is invalid`,
        );
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function string(value: Readonly<Record<string, unknown>>, field: string): string {
    const candidate = value[field];
    if (typeof candidate !== "string") {
        throw new ProjectAuthenticationError(
            "external_provider_configuration_invalid",
            `The OIDC ${field} configuration is invalid`,
        );
    }
    return candidate;
}

function url(value: Readonly<Record<string, unknown>>, field: string): URL {
    const candidate = string(value, field);
    try {
        return new URL(candidate);
    } catch (cause) {
        throw new ProjectAuthenticationError(
            "external_provider_configuration_invalid",
            `The OIDC ${field} configuration is invalid`,
            { cause },
        );
    }
}

function optionalStringArray(
    value: Readonly<Record<string, unknown>>,
    field: string,
    fallback: readonly string[],
): readonly string[] {
    const candidate = value[field];
    if (candidate === undefined) {
        return fallback;
    }
    if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== "string")) {
        throw new ProjectAuthenticationError(
            "external_provider_configuration_invalid",
            `The OIDC ${field} configuration is invalid`,
        );
    }
    return Object.freeze(candidate.filter((entry) => typeof entry === "string"));
}

function stringArray(value: unknown, name: string): readonly string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new ProjectAuthenticationError(
            "external_provider_configuration_invalid",
            `The ${name} configuration is invalid`,
        );
    }
    return Object.freeze(value.filter((entry) => typeof entry === "string"));
}

export function platformAuthenticationFromEnvironment(
    environment: PlatformAuthenticationEnvironment,
): PlatformAuthenticationConfiguration {
    const providerValues = decodedJson(environment.MOBIUS_PLATFORM_OIDC_PROVIDERS, "Platform OIDC providers");
    if (!Array.isArray(providerValues) || providerValues.length > 16) {
        throw new ProjectAuthenticationError(
            "external_provider_configuration_invalid",
            "The Platform OIDC provider configuration is invalid",
        );
    }
    const registrations = providerValues.map((providerValue) => {
        const provider = record(providerValue, "OIDC provider");
        const providerId = string(provider, "providerId");
        const configuration = new OidcProviderConfiguration(
            providerId,
            string(provider, "issuer"),
            string(provider, "audience"),
            url(provider, "jwksUrl"),
            optionalStringArray(provider, "allowedAlgorithms", DEFAULT_ALLOWED_ALGORITHMS),
            optionalStringArray(provider, "safeMetadataClaims", DEFAULT_SAFE_METADATA_CLAIMS),
            60 * 60 * 1_000,
            60 * 1_000,
            10 * 1_000,
        );
        return new RegisteredExternalIdentityAuthenticator(
            providerId,
            new OidcExternalIdentityAuthenticator(configuration),
        );
    });
    const operators = stringArray(
        decodedJson(environment.MOBIUS_PLATFORM_OPERATOR_SUBJECTS, "Platform operator subjects"),
        "Platform operator subjects",
    );
    const allowedOrigins = stringArray(
        decodedJson(environment.MOBIUS_PLATFORM_ALLOWED_ORIGINS, "Platform allowed browser origins"),
        "Platform allowed browser origins",
    );
    return new PlatformAuthenticationConfiguration(
        new ExternalIdentityAuthenticatorRegistry(registrations),
        new Set(operators),
        new Set(allowedOrigins),
    );
}
