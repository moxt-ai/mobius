export const MOBIUS_API_PREFIX = "/mobius/api";

const API_PREFIX_PATTERN = /^\/[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*$/;

export class MobiusApiConfigurationError extends Error {
    readonly code = "invalid_api_prefix";

    constructor() {
        super("The Mobius API prefix must be an absolute path without parameters");
        this.name = "MobiusApiConfigurationError";
    }
}

export function parseMobiusApiPrefix(value: unknown): string {
    if (typeof value !== "string" || !API_PREFIX_PATTERN.test(value)) {
        throw new MobiusApiConfigurationError();
    }
    return value;
}

export function mobiusApiPath(resourcePath: `/${string}`, apiPrefix: string = MOBIUS_API_PREFIX): string {
    return `${parseMobiusApiPrefix(apiPrefix)}${resourcePath}`;
}

export function mobiusApiUrl(
    origin: string | URL,
    resourcePath: `/${string}`,
    apiPrefix: string = MOBIUS_API_PREFIX,
): URL {
    return new URL(mobiusApiPath(resourcePath, apiPrefix), origin);
}
