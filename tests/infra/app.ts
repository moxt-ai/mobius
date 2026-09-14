import {
    createPlatformApplication,
    PlatformAuthenticationConfiguration,
    type PlatformRelayBindings,
} from "@moxt-ai/mobius-relay-cloudflare-platform";
import { createStandaloneApplication, type RelayBindings } from "@moxt-ai/mobius-relay-cloudflare-standalone";
import type { WorkerRuntimeGateways } from "@moxt-ai/mobius-relay-core";
import { type Env, Hono } from "hono";

export { createPlatformGateways } from "@moxt-ai/mobius-relay-cloudflare-platform";
export { createStandaloneGateways } from "@moxt-ai/mobius-relay-cloudflare-standalone";
export type { PlatformRelayBindings, RelayBindings };

/** Bind request defaults in the test adapter, leaving the production app untouched. */
class TestApplication<E extends Env> extends Hono<E> {
    override readonly request: Hono<E>["request"];

    constructor(application: Hono<E>, bindings: E["Bindings"]) {
        super();
        this.request = (input, init, environment, executionContext) =>
            application.request(input, init, environment ?? bindings, executionContext);
        this.route("/", application);
    }
}

/** The production Standalone HTTP boundary, with caller-owned storage and transport bindings. */
export function createTestMobiusApp(
    options: { readonly bindings?: RelayBindings },
    gateways: (environment: RelayBindings) => WorkerRuntimeGateways,
): Hono<{ Bindings: RelayBindings }> {
    const application = createStandaloneApplication(gateways);
    return options.bindings === undefined ? application : new TestApplication(application, options.bindings);
}

/** Share the production Platform boundary across Mobius and embedding application tests. */
export function createTestMobiusPlatformApp(
    options: PlatformAuthenticationConfiguration & {
        readonly bindings?: PlatformRelayBindings;
    },
    gateways: (environment: PlatformRelayBindings) => WorkerRuntimeGateways,
): Hono<{ Bindings: PlatformRelayBindings }> {
    const application = createPlatformApplication(
        new PlatformAuthenticationConfiguration(
            options.developerAuthenticator,
            options.operatorSubjects,
            options.allowedOrigins,
        ),
        gateways,
    );
    return options.bindings === undefined ? application : new TestApplication(application, options.bindings);
}
