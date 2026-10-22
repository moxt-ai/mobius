import { VerifiedExternalIdentity } from "@moxt-ai/mobius-relay-core";
import {
    createPlatformApplication,
    createPlatformGateways,
    PlatformAuthenticationConfiguration,
    type PlatformRelayBindings,
} from "../../relay-cloudflare-platform/src/platform-worker.ts";

const authenticator = {
    authenticate: async (
        credential: { readonly providerId: string; readonly credential: string },
        signal: AbortSignal,
    ) => {
        signal.throwIfAborted();
        if (credential.providerId !== "clerk" || credential.credential.length === 0) {
            throw new Error("The local test identity is invalid");
        }
        return new VerifiedExternalIdentity(
            "clerk",
            "https://identity.example.test",
            "developer-1",
            new Map(),
            Date.now(),
            Date.now() + 60 * 60_000,
            { kind: "organization", id: "org_mobiustest", role: "org:admin" },
        );
    },
};

const application = createPlatformApplication(
    new PlatformAuthenticationConfiguration(authenticator, new Set(["developer-1"]), new Set(["*"])),
    createPlatformGateways,
    undefined,
);

export default {
    fetch: (request: Request, environment: PlatformRelayBindings) => application.fetch(request, environment),
};

export {
    ProjectDO,
    RuntimeRelay,
} from "../../relay-cloudflare-platform/src/worker.ts";
