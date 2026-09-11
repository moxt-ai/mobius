import { env } from "cloudflare:workers";
import { createDurableObjectContext, RuntimeRelay, type SessionTransport } from "@moxt-ai/mobius-relay-core";
import { SingleDatabaseResolver } from "../src/database-resolver.ts";
import { StandaloneProjectStorageDirectory } from "../src/project-storage-directory.ts";

// Real Session DO requests cannot be made to stall deterministically. This stateful
// transport forwards real traffic, then suspends disconnect delivery until cancellation or release.
export class SuspendedDisconnectTransport implements SessionTransport {
    readonly #transport: SessionTransport = {
        fetch: (scope, sessionId, request) =>
            env.SESSION_RELAY.get(
                env.SESSION_RELAY.idFromName(`${env.MOBIUS_TENANT_ID}:${scope.projectId}:${sessionId}`),
            ).fetch(request),
    };
    readonly #suspended = Promise.withResolvers<string>();
    readonly #released = Promise.withResolvers<void>();
    #state:
        | { readonly kind: "ready" }
        | { readonly kind: "suspending"; readonly completedSessionId: string }
        | { readonly kind: "released" } = {
        kind: "ready",
    };

    readonly suspended = this.#suspended.promise;
    readonly resume = (): void => {
        this.#state = { kind: "released" };
        this.#released.resolve();
    };

    readonly fetch: SessionTransport["fetch"] = async (scope, sessionId, request) => {
        if (new URL(request.url).pathname.endsWith("/disconnect")) {
            if (this.#state.kind === "suspending") {
                request.signal.throwIfAborted();
                const aborted = Promise.withResolvers<never>();
                const cancel = () => aborted.reject(request.signal.reason);
                request.signal.addEventListener("abort", cancel, { once: true });
                this.#suspended.resolve(this.#state.completedSessionId);
                try {
                    await Promise.race([aborted.promise, this.#released.promise]);
                    return await this.#transport.fetch(scope, sessionId, request);
                } finally {
                    request.signal.removeEventListener("abort", cancel);
                }
            }
            const response = await this.#transport.fetch(scope, sessionId, request);
            if (response.ok && this.#state.kind === "ready") {
                this.#state = { kind: "suspending", completedSessionId: sessionId };
            }
            return response;
        }
        return await this.#transport.fetch(scope, sessionId, request);
    };
}

export function runtimeWithTransport(state: DurableObjectState, sessionTransport: SessionTransport): RuntimeRelay {
    return new RuntimeRelay(
        createDurableObjectContext(state, {
            environment: env,
            connections: env.BOT_CONNECTIONS,
            sessions: env.SESSION_RELAY,
            namespacePrefix: env.MOBIUS_TENANT_ID,
            databases: new SingleDatabaseResolver(env.DIRECTORY_DATABASE),
            projects: new StandaloneProjectStorageDirectory(),
            content: { kind: "sqlite" },
            sessionTransport,
        }),
    );
}
