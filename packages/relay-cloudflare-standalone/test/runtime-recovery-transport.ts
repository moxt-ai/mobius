import { env } from "cloudflare:workers";
import {
    CloudflareBotConnectionRuntime,
    CloudflareChannelPeers,
    CloudflareSessionTransport,
    DurableObjectSqlDatabase,
    RuntimeRelay,
    sessionArchiveByteLimitFromEnvironment,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare";
import { createDurableObjectDependencies, type SessionTransport } from "@moxt-ai/mobius-relay-core";
import { SingleDatabaseResolver } from "../src/database-resolver.ts";
import { StandaloneProjectStorageDirectory } from "../src/project-storage-directory.ts";

// Real Session DO requests cannot be made to stall deterministically. This stateful
// transport forwards real traffic, then suspends disconnect delivery until cancellation or release.
export class SuspendedDisconnectTransport implements SessionTransport {
    readonly #transport = new CloudflareSessionTransport(env.SESSION_RELAY, env.MOBIUS_TENANT_ID);
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
        createDurableObjectDependencies({
            doDatabase: new DurableObjectSqlDatabase(state.storage),
            quota: sessionQuotaFromEnvironment(env),
            content: { kind: "sqlite", archiveByteLimit: sessionArchiveByteLimitFromEnvironment(env) },
            gateways: {
                databaseResolver: new SingleDatabaseResolver(env.DIRECTORY_DATABASE),
                projectStorageDirectory: new StandaloneProjectStorageDirectory(),
                sessionTransport,
                connections: new CloudflareBotConnectionRuntime(env.BOT_CONNECTIONS),
                peers: new CloudflareChannelPeers(state),
                schedule: async (timestamp, signal) => {
                    signal.throwIfAborted();
                    await state.storage.setAlarm(timestamp);
                    signal.throwIfAborted();
                },
            },
        }),
    );
}
