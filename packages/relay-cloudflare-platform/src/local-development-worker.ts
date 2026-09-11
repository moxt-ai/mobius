import {
    type ExternalIdentityAuthenticator,
    type ExternalIdentityCredential,
    ProjectAuthenticationError,
    VerifiedExternalIdentity,
} from "@moxt-ai/mobius-relay-core";
import { BotConnectionActor, PlatformSessionRelay, RuntimeRelay } from "./durable-objects.ts";
import { PlatformAuthenticationConfiguration } from "./platform-control-plane.ts";
import { createPlatformWorker, type PlatformRelayBindings, type PlatformWorker } from "./worker.ts";

interface LocalDevelopmentBindings extends PlatformRelayBindings {
    readonly MOBIUS_DEMO_ALLOWED_ORIGIN: string;
    readonly MOBIUS_DEMO_DEVELOPER_TOKEN: string;
}

class LocalDeveloperAuthenticator implements ExternalIdentityAuthenticator {
    readonly #credential: string;

    constructor(credential: string) {
        if (!/^[a-zA-Z0-9_-]{32,256}$/.test(credential)) {
            throw new ProjectAuthenticationError(
                "external_provider_configuration_invalid",
                "The local Platform developer credential is invalid",
            );
        }
        this.#credential = credential;
    }

    readonly authenticate = async (
        credential: ExternalIdentityCredential,
        signal: AbortSignal,
    ): Promise<VerifiedExternalIdentity> => {
        signal.throwIfAborted();
        if (credential.providerId !== "demo-local" || credential.credential !== this.#credential) {
            throw new ProjectAuthenticationError("external_identity_invalid", "The developer identity is invalid");
        }
        const now = Date.now();
        return new VerifiedExternalIdentity(
            "demo-local",
            "https://platform-demo.local",
            "platform-demo-operator",
            new Map([["name", "Local Platform Demo Operator"]]),
            now,
            now + 60 * 60 * 1_000,
        );
    };
}

function allowedOrigin(value: string): string {
    let origin: URL;
    try {
        origin = new URL(value);
    } catch (cause) {
        throw new ProjectAuthenticationError(
            "external_provider_configuration_invalid",
            "The local Platform browser origin is invalid",
            { cause },
        );
    }
    if (
        origin.protocol !== "http:" ||
        origin.hostname !== "127.0.0.1" ||
        origin.pathname !== "/" ||
        origin.search.length > 0 ||
        origin.hash.length > 0
    ) {
        throw new ProjectAuthenticationError(
            "external_provider_configuration_invalid",
            "The local Platform browser origin must be an exact 127.0.0.1 HTTP origin",
        );
    }
    return origin.origin;
}

const workers = new Map<string, PlatformWorker>();

const worker = {
    fetch: async (request: Request, environment: LocalDevelopmentBindings): Promise<Response> => {
        const origin = allowedOrigin(environment.MOBIUS_DEMO_ALLOWED_ORIGIN);
        const key = `${environment.MOBIUS_DEMO_DEVELOPER_TOKEN}\u0000${origin}`;
        const existing = workers.get(key);
        if (existing !== undefined) {
            return await existing.fetch(request, environment);
        }
        const created = createPlatformWorker(
            new PlatformAuthenticationConfiguration(
                new LocalDeveloperAuthenticator(environment.MOBIUS_DEMO_DEVELOPER_TOKEN),
                new Set(["platform-demo-operator"]),
                new Set([origin]),
            ),
        );
        workers.set(key, created);
        return await created.fetch(request, environment);
    },
};

export { BotConnectionActor, PlatformSessionRelay, RuntimeRelay };
export default worker;
